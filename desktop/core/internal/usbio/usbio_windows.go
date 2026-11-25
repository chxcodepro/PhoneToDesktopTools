//go:build windows

package usbio

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Supported 这个系统能不能直接访问 USB 设备。Windows 只能访问驱动是 WinUSB 的接口（ADB 接口用项目自带的驱动描述文件装上 WinUSB）。
const Supported = true

// adbGUID ADB 接口的设备接口 GUID：Google USB 驱动、各手机厂商的 WinUSB 驱动、手机自带的 MS OS 描述符（Win10 自动装 WinUSB）
// 和项目自带的驱动描述文件（internal/usbdriver）都用这个
var adbGUID = windows.GUID{Data1: 0xF72FE0D4, Data2: 0xCBCB, Data3: 0x407D, Data4: [8]byte{0x88, 0x14, 0x9E, 0xD6, 0x73, 0xD0, 0xDD, 0x6B}}

var (
	modWinUSB                  = windows.NewLazySystemDLL("winusb.dll")
	procInitialize             = modWinUSB.NewProc("WinUsb_Initialize")
	procFree                   = modWinUSB.NewProc("WinUsb_Free")
	procQueryInterfaceSettings = modWinUSB.NewProc("WinUsb_QueryInterfaceSettings")
	procQueryPipe              = modWinUSB.NewProc("WinUsb_QueryPipe")
	procSetPipePolicy          = modWinUSB.NewProc("WinUsb_SetPipePolicy")
	procReadPipe               = modWinUSB.NewProc("WinUsb_ReadPipe")
	procWritePipe              = modWinUSB.NewProc("WinUsb_WritePipe")
	procAbortPipe              = modWinUSB.NewProc("WinUsb_AbortPipe")
	procGetOverlappedResult    = modWinUSB.NewProc("WinUsb_GetOverlappedResult")

	modCfgMgr       = windows.NewLazySystemDLL("cfgmgr32.dll")
	procCMGetParent = modCfgMgr.NewProc("CM_Get_Parent")
	procCMGetDevID  = modCfgMgr.NewProc("CM_Get_Device_IDW")
)

const (
	pipeTypeBulk         = 2    // UsbdPipeTypeBulk
	shortPacketTerminate = 0x01 // 写入长度是包长整数倍时自动补零长度包
	writeTimeoutMs       = 5000
	pollMs               = 500 // 等待读写完成时，每隔这么久看一下是否已经 Close
	readBufSize          = 65536
)

// usbInterfaceDescriptor USB_INTERFACE_DESCRIPTOR（9 字节，全是单字节字段）
type usbInterfaceDescriptor struct {
	Length, DescriptorType, InterfaceNumber, AlternateSetting, NumEndpoints uint8
	InterfaceClass, InterfaceSubClass, InterfaceProtocol, Interface         uint8
}

// pipeInfo WINUSB_PIPE_INFORMATION（C 布局：4 + 1 + 填充 1 + 2 + 1 + 填充 3 = 12 字节，Go 的对齐规则相同）
type pipeInfo struct {
	PipeType          uint32
	PipeID            uint8
	MaximumPacketSize uint16
	Interval          uint8
}

func cmParent(inst windows.DEVINST) (windows.DEVINST, bool) {
	var p windows.DEVINST
	r, _, _ := procCMGetParent.Call(uintptr(unsafe.Pointer(&p)), uintptr(inst), 0)
	return p, r == 0
}

func cmDeviceID(inst windows.DEVINST) string {
	buf := make([]uint16, 512)
	r, _, _ := procCMGetDevID.Call(uintptr(inst), uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)), 0)
	if r != 0 {
		return ""
	}
	return windows.UTF16ToString(buf)
}

func regString(set windows.DevInfo, d *windows.DevInfoData, p windows.SPDRP) string {
	v, err := set.DeviceRegistryProperty(d, p)
	if err != nil {
		return ""
	}
	s, _ := v.(string)
	return s
}

// parseInstanceID 从设备实例 ID（如 USB\VID_22D9&PID_2765\3B1F5JE5MS12F371）取出 VID、PID 和序列号。
// 设备没有序列号时 Windows 用「6&5005726&0&2」这样按插口生成的 ID，此时序列号为空。
func parseInstanceID(id string) (vid, pid uint16, serial string) {
	parts := strings.Split(id, `\`)
	if len(parts) < 3 {
		return 0, 0, ""
	}
	for _, f := range strings.Split(strings.ToUpper(parts[1]), "&") {
		if v, ok := strings.CutPrefix(f, "VID_"); ok {
			n, _ := strconv.ParseUint(v, 16, 16)
			vid = uint16(n)
		}
		if v, ok := strings.CutPrefix(f, "PID_"); ok {
			n, _ := strconv.ParseUint(v, 16, 16)
			pid = uint16(n)
		}
	}
	if s := parts[2]; !strings.Contains(s, "&") {
		serial = s
	}
	return vid, pid, serial
}

// ADBDevices 插着的、开了 USB 调试的设备（ADB 接口装好了驱动的）
func ADBDevices() ([]ADBDevice, error) {
	set, err := windows.SetupDiGetClassDevsEx(&adbGUID, "", 0, windows.DIGCF_PRESENT|windows.DIGCF_DEVICEINTERFACE, 0, "")
	if err != nil {
		return nil, err
	}
	defer set.Close()
	var out []ADBDevice
	for i := 0; ; i++ {
		d, err := set.EnumDeviceInfo(i)
		if err != nil {
			if errors.Is(err, windows.ERROR_NO_MORE_ITEMS) {
				break
			}
			continue
		}
		inst, err := set.DeviceInstanceID(d)
		if err != nil {
			continue
		}
		paths, err := windows.CM_Get_Device_Interface_List(inst, &adbGUID, windows.CM_GET_DEVICE_INTERFACE_LIST_PRESENT)
		if err != nil || len(paths) == 0 || paths[0] == "" {
			continue
		}
		// 复合设备（MTP + ADB）的 ADB 接口是子节点（…&MI_01），序列号在父节点上
		devID := inst
		if strings.Contains(strings.ToUpper(inst), "&MI_") {
			if p, ok := cmParent(d.DevInst); ok {
				if id := cmDeviceID(p); id != "" {
					devID = id
				}
			}
		}
		vid, pid, serial := parseInstanceID(devID)
		out = append(out, ADBDevice{
			Key: paths[0], Serial: serial, VID: vid, PID: pid,
			Product: regString(set, d, windows.SPDRP_FRIENDLYNAME),
			Driver:  regString(set, d, windows.SPDRP_SERVICE),
			node:    paths[0],
		})
	}
	return out, nil
}

// Open 打开 ADB 接口
func (d ADBDevice) Open() (Pipe, error) {
	path, err := windows.UTF16PtrFromString(d.node)
	if err != nil {
		return nil, err
	}
	h, err := windows.CreateFile(path, windows.GENERIC_READ|windows.GENERIC_WRITE, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE,
		nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL|windows.FILE_FLAG_OVERLAPPED, 0)
	if err != nil {
		if errors.Is(err, windows.ERROR_ACCESS_DENIED) || errors.Is(err, windows.ERROR_SHARING_VIOLATION) || errors.Is(err, windows.ERROR_BUSY) {
			return nil, ErrBusy
		}
		return nil, fmt.Errorf("打开 USB 接口失败：%w", err)
	}
	if err := procInitialize.Find(); err != nil {
		windows.CloseHandle(h)
		return nil, fmt.Errorf("系统没有 WinUSB：%w", err)
	}
	var wu uintptr
	if r, _, e := procInitialize.Call(uintptr(h), uintptr(unsafe.Pointer(&wu))); r == 0 {
		windows.CloseHandle(h)
		if d.Driver != "" && !strings.EqualFold(d.Driver, "WinUSB") {
			return nil, fmt.Errorf("手机的 ADB 驱动是 %s，不是 WinUSB（%v）", d.Driver, e)
		}
		return nil, fmt.Errorf("初始化 WinUSB 失败：%w", e)
	}
	p := &winPipe{file: h, wu: wu}
	fail := func(err error) (Pipe, error) {
		procFree.Call(wu)
		windows.CloseHandle(h)
		return nil, err
	}
	var desc usbInterfaceDescriptor
	if r, _, e := procQueryInterfaceSettings.Call(wu, 0, uintptr(unsafe.Pointer(&desc))); r == 0 {
		return fail(fmt.Errorf("读取 USB 接口失败：%w", e))
	}
	found := 0
	for i := 0; i < int(desc.NumEndpoints); i++ {
		var pi pipeInfo
		if r, _, _ := procQueryPipe.Call(wu, 0, uintptr(i), uintptr(unsafe.Pointer(&pi))); r == 0 || pi.PipeType != pipeTypeBulk {
			continue
		}
		if pi.PipeID&0x80 != 0 && p.in == 0 {
			p.in = pi.PipeID
			found |= 1
		} else if pi.PipeID&0x80 == 0 && p.out == 0 {
			p.out = pi.PipeID
			found |= 2
		}
	}
	if found != 3 {
		return fail(errors.New("ADB 接口没有一对 bulk 端点"))
	}
	on := uint8(1)
	procSetPipePolicy.Call(wu, uintptr(p.out), shortPacketTerminate, 1, uintptr(unsafe.Pointer(&on)))
	for _, ov := range []**windows.Overlapped{&p.rov, &p.wov} {
		ev, err := windows.CreateEvent(nil, 1, 0, nil)
		if err != nil {
			if p.rov != nil {
				windows.CloseHandle(p.rov.HEvent)
			}
			return fail(err)
		}
		*ov = &windows.Overlapped{HEvent: ev}
	}
	p.rbuf = make([]byte, readBufSize)
	return p, nil
}

// winPipe WinUSB 的一对 bulk 端点，用重叠 I/O 读写（WinUSB 要求），读和写可以同时进行。
// 内核读写的是 rbuf、wbuf 和两个 Overlapped，它们都在 Go 堆上（不会被移动），由 winPipe 引用着。
type winPipe struct {
	file     windows.Handle
	wu       uintptr
	in, out  uint8
	rov, wov *windows.Overlapped
	rbuf     []byte
	wbuf     []byte
	rmu, wmu sync.Mutex
	closed   atomic.Bool
	freeOnce sync.Once
}

// xfer 发起一次读或写并等它结束。timeoutMs 为 0 表示一直等（直到 Close）。
func (p *winPipe) xfer(proc *windows.LazyProc, pipe uint8, buf []byte, ov *windows.Overlapped, timeoutMs uint32) (int, error) {
	if p.closed.Load() {
		return 0, os.ErrClosed
	}
	_ = windows.ResetEvent(ov.HEvent)
	var ptr uintptr
	if len(buf) > 0 {
		ptr = uintptr(unsafe.Pointer(&buf[0]))
	}
	if r, _, e := proc.Call(p.wu, uintptr(pipe), ptr, uintptr(len(buf)), 0, uintptr(unsafe.Pointer(ov))); r == 0 && e != windows.ERROR_IO_PENDING {
		return 0, e
	}
	var waited uint32
	for {
		ev, _ := windows.WaitForSingleObject(ov.HEvent, pollMs)
		if ev == windows.WAIT_OBJECT_0 {
			break
		}
		waited += pollMs
		closed := p.closed.Load()
		if closed || (timeoutMs > 0 && waited >= timeoutMs) {
			procAbortPipe.Call(p.wu, uintptr(pipe))
			_, _ = windows.WaitForSingleObject(ov.HEvent, windows.INFINITE)
			if closed {
				return 0, os.ErrClosed
			}
			return 0, ErrTimeout
		}
	}
	var n uint32
	if r, _, e := procGetOverlappedResult.Call(p.wu, uintptr(unsafe.Pointer(ov)), uintptr(unsafe.Pointer(&n)), 0); r == 0 {
		if p.closed.Load() {
			return int(n), os.ErrClosed
		}
		return int(n), e
	}
	return int(n), nil
}

func (p *winPipe) Read(b []byte) (int, error) {
	p.rmu.Lock()
	defer p.rmu.Unlock()
	n := len(b)
	if n > len(p.rbuf) {
		n = len(p.rbuf)
	}
	got, err := p.xfer(procReadPipe, p.in, p.rbuf[:n], p.rov, 0)
	if err != nil {
		return 0, err
	}
	return copy(b, p.rbuf[:got]), nil
}

func (p *winPipe) Write(b []byte) error {
	p.wmu.Lock()
	defer p.wmu.Unlock()
	if cap(p.wbuf) < len(b) {
		p.wbuf = make([]byte, len(b))
	}
	buf := p.wbuf[:len(b)]
	copy(buf, b)
	n, err := p.xfer(procWritePipe, p.out, buf, p.wov, writeTimeoutMs)
	if err == nil && n != len(b) {
		err = fmt.Errorf("只写出了 %d / %d 字节", n, len(b))
	}
	return err
}

func (p *winPipe) Close() error {
	if p.closed.Swap(true) {
		return nil
	}
	procAbortPipe.Call(p.wu, uintptr(p.in))
	procAbortPipe.Call(p.wu, uintptr(p.out))
	go func() { // 等进行中的读写退出后再释放
		p.rmu.Lock()
		p.wmu.Lock()
		defer p.rmu.Unlock()
		defer p.wmu.Unlock()
		p.freeOnce.Do(func() {
			procFree.Call(p.wu)
			windows.CloseHandle(p.file)
			windows.CloseHandle(p.rov.HEvent)
			windows.CloseHandle(p.wov.HEvent)
		})
	}()
	return nil
}
