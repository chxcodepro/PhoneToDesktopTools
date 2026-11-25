//go:build linux

package aoa

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

// Supported 这个系统能不能用免调试连接。Linux 直接用内核的 usbfs，不需要 libusb，龙芯也能用。
const Supported = true

func newBackend() usbBackend { return sysfsBackend{root: "/sys/bus/usb/devices", dev: "/dev/bus/usb"} }

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
	// 写入超时：手机端正常时随时在读，几毫秒就写完；超时说明手机端 App 不在读了
	writeTimeoutMs = 3000
)

type sysfsBackend struct{ root, dev string }

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

func (b sysfsBackend) List() ([]usbDevice, error) {
	entries, err := os.ReadDir(b.root)
	if err != nil {
		return nil, err
	}
	var out []usbDevice
	for _, e := range entries {
		name := e.Name()
		if strings.Contains(name, ":") || strings.HasPrefix(name, "usb") {
			continue // 接口，或根集线器
		}
		dir := filepath.Join(b.root, name)
		vid, pid := hexAttr(dir, "idVendor"), hexAttr(dir, "idProduct")
		bus, addr := decAttr(dir, "busnum"), decAttr(dir, "devnum")
		if vid < 0 || pid < 0 || bus < 0 || addr < 0 || hexAttr(dir, "bDeviceClass") == 0x09 {
			continue
		}
		d := usbDevice{
			Name: name, Bus: bus, Addr: addr, VID: uint16(vid), PID: uint16(pid),
			Serial: readAttr(dir, "serial"), Product: readAttr(dir, "product"), Manufacturer: readAttr(dir, "manufacturer"),
		}
		for _, ie := range entries {
			in := ie.Name()
			if !strings.HasPrefix(in, name+":") {
				continue
			}
			idir := filepath.Join(b.root, in)
			it := usbIface{
				Num: hexAttr(idir, "bInterfaceNumber"), Class: hexAttr(idir, "bInterfaceClass"),
				SubClass: hexAttr(idir, "bInterfaceSubClass"), Protocol: hexAttr(idir, "bInterfaceProtocol"),
			}
			eps, _ := filepath.Glob(filepath.Join(idir, "ep_*"))
			for _, ep := range eps {
				a := hexAttr(ep, "bEndpointAddress")
				if a < 0 {
					continue
				}
				it.EPs = append(it.EPs, usbEP{Addr: a, Bulk: readAttr(ep, "type") == "Bulk", In: a&0x80 != 0})
			}
			d.Ifaces = append(d.Ifaces, it)
		}
		out = append(out, d)
	}
	return out, nil
}

func (b sysfsBackend) node(d usbDevice) string {
	return filepath.Join(b.dev, fmt.Sprintf("%03d", d.Bus), fmt.Sprintf("%03d", d.Addr))
}

func (b sysfsBackend) open(d usbDevice) (int, error) {
	fd, err := unix.Open(b.node(d), unix.O_RDWR|unix.O_CLOEXEC, 0)
	if err != nil {
		if errors.Is(err, unix.EACCES) || errors.Is(err, unix.EPERM) {
			return -1, errPermission
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

// control 发一个控制请求。out 为发送的数据（OUT 请求），in 为接收长度（IN 请求）
func control(fd int, reqType, req uint8, value, index uint16, out []byte, in int) ([]byte, error) {
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
	r, err := ioctl(fd, ioctlControl, unsafe.Pointer(&ct))
	if err != nil {
		return nil, err
	}
	if in > 0 {
		return append([]byte(nil), data[:r]...), nil
	}
	return nil, nil
}

const (
	reqTypeVendorIn  = 0xC0 // 设备 → 电脑、厂商请求、接收者为设备
	reqTypeVendorOut = 0x40
)

func getProtocol(fd int) (int, error) {
	b, err := control(fd, reqTypeVendorIn, reqGetProtocol, 0, 0, nil, 2)
	if err != nil {
		return 0, err
	}
	if len(b) < 2 {
		return 0, fmt.Errorf("GET_PROTOCOL 返回了 %d 字节", len(b))
	}
	return int(b[0]) | int(b[1])<<8, nil
}

func (b sysfsBackend) Probe(d usbDevice) (int, error) {
	fd, err := b.open(d)
	if err != nil {
		return 0, err
	}
	defer unix.Close(fd)
	return getProtocol(fd)
}

func (b sysfsBackend) Switch(d usbDevice, strs [6]string) error {
	fd, err := b.open(d)
	if err != nil {
		return err
	}
	defer unix.Close(fd)
	v, err := getProtocol(fd)
	if err != nil {
		return fmt.Errorf("手机不支持配件模式：%w", err)
	}
	if v < 1 {
		return fmt.Errorf("手机不支持配件模式（协议版本 %d）", v)
	}
	for i, s := range strs {
		if _, err := control(fd, reqTypeVendorOut, reqSendString, 0, uint16(i), append([]byte(s), 0), 0); err != nil {
			return fmt.Errorf("发送识别信息失败：%w", err)
		}
	}
	if _, err := control(fd, reqTypeVendorOut, reqStart, 0, 0, nil, 0); err != nil {
		return fmt.Errorf("切换配件模式失败：%w", err)
	}
	return nil
}

func (b sysfsBackend) Open(d usbDevice) (transport, error) {
	iface, in, out, ok := d.accessoryEndpoints()
	if !ok {
		return nil, errors.New("没有找到配件接口")
	}
	fd, err := b.open(d)
	if err != nil {
		return nil, err
	}
	num := uint32(iface)
	if _, err := ioctl(fd, ioctlClaim, unsafe.Pointer(&num)); err != nil {
		unix.Close(fd)
		return nil, fmt.Errorf("认领配件接口失败：%w", err)
	}
	rb, err := newBuffer(readBufSize)
	if err != nil {
		unix.Close(fd)
		return nil, err
	}
	wb, err := newBuffer(readBufSize)
	if err != nil {
		rb.free()
		unix.Close(fd)
		return nil, err
	}
	return &usbfsTransport{fd: fd, iface: num, in: uint32(in), out: uint32(out), rb: rb, wb: wb}, nil
}

// usbfsTransport 配件接口的 bulk 读写。读和写各在自己的协程里同时进行；Close 等进行中的读写结束后再关闭设备，
// 免得设备号被新打开的文件复用、或缓冲区释放后内核还在写。
type usbfsTransport struct {
	fd       int
	iface    uint32
	in, out  uint32
	rb, wb   buffer
	rmu, wmu sync.Mutex // 读、写各自串行
	life     sync.RWMutex
	closed   bool
}

func (t *usbfsTransport) bulk(ep uint32, buf buffer, n int, timeout uint32) (int, error) {
	t.life.RLock()
	defer t.life.RUnlock()
	if t.closed {
		return 0, os.ErrClosed
	}
	bt := bulkTransfer{Ep: ep, Len: uint32(n), Timeout: timeout, Data: buf.addr()}
	r, err := ioctl(t.fd, ioctlBulk, unsafe.Pointer(&bt))
	if errors.Is(err, unix.ETIMEDOUT) {
		return 0, errTimeout
	}
	return r, err
}

func (t *usbfsTransport) Read(p []byte) (int, error) {
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

func (t *usbfsTransport) Write(p []byte) error {
	t.wmu.Lock()
	defer t.wmu.Unlock()
	if len(p) > len(t.wb) {
		return fmt.Errorf("一次写入 %d 字节，超过了 %d", len(p), len(t.wb))
	}
	copy(t.wb, p)
	r, err := t.bulk(t.out, t.wb, len(p), writeTimeoutMs)
	if err == nil && r != len(p) {
		err = fmt.Errorf("只写出了 %d / %d 字节", r, len(p))
	}
	return err
}

func (t *usbfsTransport) Close() error {
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
