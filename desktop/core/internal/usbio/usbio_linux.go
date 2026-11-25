//go:build linux

package usbio

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"unsafe"

	"golang.org/x/sys/unix"
)

// Supported 这个系统能不能直接访问 USB 设备。Linux 直接用内核的 usbfs，不需要 libusb，龙芯也能用。
const Supported = true

const (
	SysfsRoot = "/sys/bus/usb/devices"
	DevRoot   = "/dev/bus/usb"
)

// usbfs 的 ioctl（linux/usbdevice_fs.h）。结构体布局和 C 一致：Go 的对齐规则和 C 相同，指针字段在 64 位系统上对齐到 8 字节。
type ctrlTransfer struct {
	RequestType uint8
	Request     uint8
	Value       uint16
	Index       uint16
	Length      uint16
	Timeout     uint32 // 毫秒
	Data        uintptr
}

type bulkTransfer struct {
	Ep      uint32
	Len     uint32
	Timeout uint32 // 毫秒
	Data    uintptr
}

func usbIoctl(dir, nr, size uintptr) uintptr { return dir<<30 | size<<16 | uintptr('U')<<8 | nr }

const (
	iocWrite = 1
	iocRead  = 2
)

var (
	ioctlControl = usbIoctl(iocRead|iocWrite, 0, unsafe.Sizeof(ctrlTransfer{}))
	ioctlBulk    = usbIoctl(iocRead|iocWrite, 2, unsafe.Sizeof(bulkTransfer{}))
	ioctlClaim   = usbIoctl(iocRead, 15, 4)
	ioctlRelease = usbIoctl(iocRead, 16, 4)
)

const (
	ctrlTimeoutMs = 1000
	readTimeoutMs = 1000
	// 写入超时：对方正常时随时在读，几毫秒就写完；超时说明对方不在读了
	writeTimeoutMs = 3000
	// bufSize 每次读写的缓冲：16 KiB，是 512 和 1024 的整数倍（bulk 读请求的长度要是包大小的整数倍）。
	// 老内核的 usbfs 一次 bulk 传输最多 16 KiB。
	bufSize = 16384
)

func readAttr(dir, name string) string {
	b, err := os.ReadFile(filepath.Join(dir, name))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

func hexAttr(dir, name string) int {
	v, err := strconv.ParseUint(readAttr(dir, name), 16, 32)
	if err != nil {
		return -1
	}
	return int(v)
}

func decAttr(dir, name string) int {
	v, err := strconv.Atoi(readAttr(dir, name))
	if err != nil {
		return -1
	}
	return v
}

// List 列出 root（正常是 SysfsRoot）下插着的设备，不含集线器
func List(root string) ([]Device, error) {
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil, err
	}
	var out []Device
	for _, e := range entries {
		name := e.Name()
		if strings.Contains(name, ":") || strings.HasPrefix(name, "usb") {
			continue // 接口，或根集线器
		}
		dir := filepath.Join(root, name)
		vid, pid := hexAttr(dir, "idVendor"), hexAttr(dir, "idProduct")
		bus, addr := decAttr(dir, "busnum"), decAttr(dir, "devnum")
		if vid < 0 || pid < 0 || bus < 0 || addr < 0 || hexAttr(dir, "bDeviceClass") == 0x09 {
			continue
		}
		d := Device{
			Name: name, Bus: bus, Addr: addr, VID: uint16(vid), PID: uint16(pid),
			Serial: readAttr(dir, "serial"), Product: readAttr(dir, "product"), Manufacturer: readAttr(dir, "manufacturer"),
		}
		for _, ie := range entries {
			in := ie.Name()
			if !strings.HasPrefix(in, name+":") {
				continue
			}
			idir := filepath.Join(root, in)
			it := Iface{
				Num: hexAttr(idir, "bInterfaceNumber"), Class: hexAttr(idir, "bInterfaceClass"),
				SubClass: hexAttr(idir, "bInterfaceSubClass"), Protocol: hexAttr(idir, "bInterfaceProtocol"),
			}
			eps, _ := filepath.Glob(filepath.Join(idir, "ep_*"))
			for _, ep := range eps {
				a := hexAttr(ep, "bEndpointAddress")
				if a < 0 {
					continue
				}
				mp := hexAttr(ep, "wMaxPacketSize")
				if mp < 0 {
					mp = 0
				}
				mp &= 0x7FF // 高位是高带宽端点的附加事务数
				it.EPs = append(it.EPs, EP{Addr: a, Bulk: readAttr(ep, "type") == "Bulk", In: a&0x80 != 0, MaxPacket: mp})
			}
			d.Ifaces = append(d.Ifaces, it)
		}
		out = append(out, d)
	}
	return out, nil
}

// Node 设备节点，如 /dev/bus/usb/001/007
func Node(devRoot string, d Device) string {
	return filepath.Join(devRoot, fmt.Sprintf("%03d", d.Bus), fmt.Sprintf("%03d", d.Addr))
}

func openNode(node string) (int, error) {
	fd, err := unix.Open(node, unix.O_RDWR|unix.O_CLOEXEC, 0)
	if err != nil {
		if errors.Is(err, unix.EACCES) || errors.Is(err, unix.EPERM) {
			return -1, ErrPermission
		}
		return -1, err
	}
	return fd, nil
}

// buffer 内核读写用的内存。用 mmap 分配在 Go 堆以外，ioctl 期间不受垃圾回收影响。
type buffer []byte

func newBuffer(n int) (buffer, error) {
	return unix.Mmap(-1, 0, n, unix.PROT_READ|unix.PROT_WRITE, unix.MAP_ANON|unix.MAP_PRIVATE)
}

func (p buffer) free() { _ = unix.Munmap(p) }

func (p buffer) addr() uintptr { return uintptr(unsafe.Pointer(&p[0])) }

func ioctl(fd int, req uintptr, arg unsafe.Pointer) (int, error) {
	r, _, e := unix.Syscall(unix.SYS_IOCTL, uintptr(fd), req, uintptr(arg))
	if e != 0 {
		return int(r), e
	}
	return int(r), nil
}

// Handle 打开的设备，用来发控制请求
type Handle struct{ fd int }

// OpenDevice 打开设备节点
func OpenDevice(node string) (*Handle, error) {
	fd, err := openNode(node)
	if err != nil {
		return nil, err
	}
	return &Handle{fd: fd}, nil
}

func (h *Handle) Close() error { return unix.Close(h.fd) }

// Control 发一个控制请求。out 为发送的数据（OUT 请求），in 为接收长度（IN 请求）
func (h *Handle) Control(reqType, req uint8, value, index uint16, out []byte, in int) ([]byte, error) {
	n := len(out)
	if in > n {
		n = in
	}
	var data buffer
	ct := ctrlTransfer{RequestType: reqType, Request: req, Value: value, Index: index, Length: uint16(n), Timeout: ctrlTimeoutMs}
	if n > 0 {
		var err error
		if data, err = newBuffer(n); err != nil {
			return nil, err
		}
		defer data.free()
		copy(data, out)
		ct.Data = data.addr()
	}
	r, err := ioctl(h.fd, ioctlControl, unsafe.Pointer(&ct))
	if err != nil {
		return nil, err
	}
	if in > 0 {
		return append([]byte(nil), data[:r]...), nil
	}
	return nil, nil
}

// BulkOptions 打开 bulk 端点的选项
type BulkOptions struct {
	// Stream 为 true 时 Write 可以写任意长度：按缓冲区大小分几次写，长度正好是包长整数倍时最后补一个零长度包，
	// 对方的读请求才能结束（ADB 需要）。为 false 时一次 Write 就是一次 USB 传输，长度不能超过 16 KiB（免调试连接自己分块）。
	Stream bool
	// MaxPacket OUT 端点的最大包长，Stream 时用
	MaxPacket int
}

// OpenBulk 打开设备，认领接口 iface，返回它的一对 bulk 端点
func OpenBulk(node string, iface, in, out int, opt BulkOptions) (Pipe, error) {
	fd, err := openNode(node)
	if err != nil {
		return nil, err
	}
	num := uint32(iface)
	if _, err := ioctl(fd, ioctlClaim, unsafe.Pointer(&num)); err != nil {
		unix.Close(fd)
		if errors.Is(err, unix.EBUSY) {
			return nil, ErrBusy
		}
		return nil, fmt.Errorf("认领 USB 接口失败：%w", err)
	}
	rb, err := newBuffer(bufSize)
	if err != nil {
		unix.Close(fd)
		return nil, err
	}
	wb, err := newBuffer(bufSize)
	if err != nil {
		rb.free()
		unix.Close(fd)
		return nil, err
	}
	if opt.MaxPacket <= 0 {
		opt.MaxPacket = 512
	}
	return &usbfsPipe{fd: fd, iface: num, in: uint32(in), out: uint32(out), rb: rb, wb: wb, opt: opt}, nil
}

// usbfsPipe 一对 bulk 端点。读和写各在自己的协程里同时进行；Close 等进行中的读写结束后再关闭设备，
// 免得设备号被新打开的文件复用、或缓冲区释放后内核还在写。
type usbfsPipe struct {
	fd       int
	iface    uint32
	in, out  uint32
	rb, wb   buffer
	opt      BulkOptions
	rmu, wmu sync.Mutex // 读、写各自串行
	life     sync.RWMutex
	closed   bool
}

func (t *usbfsPipe) bulk(ep uint32, buf buffer, n int, timeout uint32) (int, error) {
	t.life.RLock()
	defer t.life.RUnlock()
	if t.closed {
		return 0, os.ErrClosed
	}
	bt := bulkTransfer{Ep: ep, Len: uint32(n), Timeout: timeout}
	if n > 0 {
		bt.Data = buf.addr()
	}
	r, err := ioctl(t.fd, ioctlBulk, unsafe.Pointer(&bt))
	if errors.Is(err, unix.ETIMEDOUT) {
		return 0, ErrTimeout
	}
	return r, err
}

func (t *usbfsPipe) Read(p []byte) (int, error) {
	t.rmu.Lock()
	defer t.rmu.Unlock()
	n := len(p)
	if n > len(t.rb) {
		n = len(t.rb)
	}
	r, err := t.bulk(t.in, t.rb, n, readTimeoutMs)
	if err != nil {
		return 0, err
	}
	return copy(p, t.rb[:r]), nil
}

func (t *usbfsPipe) writeOnce(p []byte) error {
	copy(t.wb, p)
	r, err := t.bulk(t.out, t.wb, len(p), writeTimeoutMs)
	if err == nil && r != len(p) {
		err = fmt.Errorf("只写出了 %d / %d 字节", r, len(p))
	}
	return err
}

func (t *usbfsPipe) Write(p []byte) error {
	t.wmu.Lock()
	defer t.wmu.Unlock()
	if !t.opt.Stream {
		if len(p) > len(t.wb) {
			return fmt.Errorf("一次写入 %d 字节，超过了 %d", len(p), len(t.wb))
		}
		return t.writeOnce(p)
	}
	total := len(p)
	for len(p) > 0 {
		n := len(p)
		if n > len(t.wb) {
			n = len(t.wb)
		}
		if err := t.writeOnce(p[:n]); err != nil {
			return err
		}
		p = p[n:]
	}
	if total > 0 && total%t.opt.MaxPacket == 0 {
		return t.writeOnce(nil) // 零长度包
	}
	return nil
}

func (t *usbfsPipe) Close() error {
	go func() { // 读请求最多要等 readTimeoutMs 才结束，不阻塞调用方
		t.life.Lock()
		defer t.life.Unlock()
		if t.closed {
			return
		}
		t.closed = true
		num := t.iface
		_, _ = ioctl(t.fd, ioctlRelease, unsafe.Pointer(&num))
		_ = unix.Close(t.fd)
		t.rb.free()
		t.wb.free()
	}()
	return nil
}

// ADBDevices 插着的、开了 USB 调试的设备
func ADBDevices() ([]ADBDevice, error) {
	list, err := List(SysfsRoot)
	if err != nil {
		return nil, err
	}
	var out []ADBDevice
	for _, d := range list {
		iface, in, o, mp, ok := d.ADBEndpoints()
		if !ok {
			continue
		}
		out = append(out, ADBDevice{
			Key: fmt.Sprintf("%s#%d", d.Name, d.Addr), Serial: d.Serial, Product: d.Product, VID: d.VID, PID: d.PID,
			node: Node(DevRoot, d), iface: iface, in: in, out: o, maxPacket: mp,
		})
	}
	return out, nil
}

// Open 打开 ADB 接口
func (d ADBDevice) Open() (Pipe, error) {
	return OpenBulk(d.node, d.iface, d.in, d.out, BulkOptions{Stream: true, MaxPacket: d.maxPacket})
}
