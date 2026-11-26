// Package usbio 直接读写 USB 设备的 bulk 端点，不依赖 libusb：Linux 用内核的 usbfs，Windows 用系统自带的 WinUSB，
// macOS 用 IOKit（只做了 ADB，要用 cgo 编译）。
// 免调试连接（internal/aoa）和 ADB（internal/adbwire）都用它。
package usbio

import "errors"

// Device 系统里的一个 USB 设备（Linux 从 /sys/bus/usb/devices 读取）
type Device struct {
	Name         string // sysfs 名，如 1-2、1-2.3（按插口固定，换口会变）
	Bus, Addr    int    // 总线号、设备号（每次插拔设备号都会变）
	VID, PID     uint16
	Serial       string
	Product      string
	Manufacturer string
	Ifaces       []Iface
}

// Iface 设备的一个接口
type Iface struct {
	Num, Class, SubClass, Protocol int
	EPs                            []EP
}

// EP 接口的一个端点
type EP struct {
	Addr      int  // 端点地址，最高位 1 表示 IN
	Bulk      bool // 是否 bulk 端点
	In        bool
	MaxPacket int // 最大包长（USB 2.0 高速是 512，USB 3.0 是 1024）；读不到时为 0
}

// 接口类型
const (
	ClassStill  = 0x06 // 静态图像类：MTP / PTP（06/01/01）
	ClassVendor = 0xFF // 厂商自定义：ADB（FF/42/01）、配件（FF/FF/00）
)

func (d Device) HasIface(class, sub, proto int) bool {
	for _, i := range d.Ifaces {
		if i.Class == class && i.SubClass == sub && i.Protocol == proto {
			return true
		}
	}
	return false
}

// HasADB 开了 USB 调试的安卓手机有 ADB 接口
func (d Device) HasADB() bool { return d.HasIface(ClassVendor, 0x42, 0x01) }

// MaybePhone 可能是安卓手机：有 MTP 接口（没开 USB 调试时默认的「仅充电」也是 MTP，只是不给访问文件）或 ADB 接口。
// 数码相机等也有 PTP 接口，免调试连接靠之后的 GET_PROTOCOL 探测排除（不支持的设备会拒绝这个请求）。
func (d Device) MaybePhone() bool {
	return d.HasIface(ClassStill, 0x01, 0x01) || d.HasADB()
}

// bulkPair 接口里的第一对 bulk IN / OUT 端点
func bulkPair(i Iface) (in, out, maxPacket int, ok bool) {
	in, out = -1, -1
	for _, ep := range i.EPs {
		if !ep.Bulk {
			continue
		}
		if ep.In && in < 0 {
			in = ep.Addr
		}
		if !ep.In && out < 0 {
			out = ep.Addr
			maxPacket = ep.MaxPacket
		}
	}
	return in, out, maxPacket, in >= 0 && out >= 0
}

// AccessoryEndpoints 配件接口（接口 0）的 bulk IN / OUT 端点
func (d Device) AccessoryEndpoints() (iface, in, out int, ok bool) {
	for _, i := range d.Ifaces {
		if i.Class != ClassVendor || i.SubClass != 0xFF {
			continue
		}
		if in, out, _, ok := bulkPair(i); ok {
			return i.Num, in, out, true
		}
	}
	return 0, 0, 0, false
}

// ADBEndpoints ADB 接口（FF/42/01）的 bulk IN / OUT 端点和 OUT 端点的最大包长
func (d Device) ADBEndpoints() (iface, in, out, maxPacket int, ok bool) {
	for _, i := range d.Ifaces {
		if i.Class != ClassVendor || i.SubClass != 0x42 || i.Protocol != 0x01 {
			continue
		}
		if in, out, mp, ok := bulkPair(i); ok {
			return i.Num, in, out, mp, true
		}
	}
	return 0, 0, 0, 0, false
}

// Pipe 一对 bulk 端点。Read 一次读一个 USB 传输（最多 len(p) 字节）；Read 和 Write 可以在不同的协程里同时调用。
type Pipe interface {
	// Read 读一次。Linux 一段时间（1 秒）没有数据返回 ErrTimeout，调用方接着读即可；Windows、macOS 一直等到有数据或 Close。
	Read(p []byte) (int, error)
	Write(p []byte) error
	// Close 关闭端点，正在进行的 Read / Write 随后返回错误
	Close() error
}

var (
	// ErrTimeout 读写超时
	ErrTimeout = errors.New("超时")
	// ErrPermission 没有权限打开设备节点（Linux 的 /dev/bus/usb/…）
	ErrPermission = errors.New("没有权限访问这台手机的 USB 设备")
	// ErrBusy 接口被别的程序占着（如 Android Studio 的 adb）
	ErrBusy = errors.New("手机的 USB 调试接口被其他程序占用")
	// ErrUnsupported 这个系统不支持
	ErrUnsupported = errors.New("这个系统不支持直接访问 USB 设备")
)

// ADBDevice 开了 USB 调试的手机的 ADB 接口
type ADBDevice struct {
	// Key 区分插着的设备：Linux 是插口和设备号（重新插拔会变），Windows 是设备接口路径，macOS 是接口的注册表 ID（重新插拔会变）
	Key string
	// Serial USB 序列号，和 adb devices 列出的相同；设备没有序列号时为空
	Serial   string
	Product  string
	VID, PID uint16
	// Driver Windows 上 ADB 接口的驱动服务名，正常是 WinUSB
	Driver string

	// Linux：设备节点和端点；Windows：设备接口路径；macOS：接口的注册表 ID（十进制）
	node                      string
	iface, in, out, maxPacket int
}
