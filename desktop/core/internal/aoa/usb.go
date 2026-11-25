package aoa

import "errors"

// usbDevice 系统里的一个 USB 设备（Linux 从 /sys/bus/usb/devices 读取）
type usbDevice struct {
	Name         string // sysfs 名，如 1-2、1-2.3（按插口固定，换口会变）
	Bus, Addr    int    // 总线号、设备号（每次插拔设备号都会变）
	VID, PID     uint16
	Serial       string
	Product      string
	Manufacturer string
	Ifaces       []usbIface
}

type usbIface struct {
	Num, Class, SubClass, Protocol int
	EPs                            []usbEP
}

type usbEP struct {
	Addr int  // 端点地址，最高位 1 表示 IN
	Bulk bool // 是否 bulk 端点
	In   bool
}

// 接口类型
const (
	classStill  = 0x06 // 静态图像类：MTP / PTP（06/01/01）
	classVendor = 0xFF // 厂商自定义：ADB（FF/42/01）、配件（FF/FF/00）
)

func (d usbDevice) hasIface(class, sub, proto int) bool {
	for _, i := range d.Ifaces {
		if i.Class == class && i.SubClass == sub && i.Protocol == proto {
			return true
		}
	}
	return false
}

// hasADB 开了 USB 调试的安卓手机有 ADB 接口
func (d usbDevice) hasADB() bool { return d.hasIface(classVendor, 0x42, 0x01) }

// maybePhone 可能是安卓手机：有 MTP 接口（没开 USB 调试时默认的「仅充电」也是 MTP，只是不给访问文件）或 ADB 接口。
// 数码相机等也有 PTP 接口，靠之后的 GET_PROTOCOL 探测排除（不支持的设备会拒绝这个请求）。
func (d usbDevice) maybePhone() bool {
	return d.hasIface(classStill, 0x01, 0x01) || d.hasADB()
}

// accessoryEndpoints 配件接口（接口 0）的 bulk IN / OUT 端点
func (d usbDevice) accessoryEndpoints() (iface, in, out int, ok bool) {
	for _, i := range d.Ifaces {
		if i.Class != classVendor || i.SubClass != 0xFF {
			continue
		}
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
			}
		}
		if in >= 0 && out >= 0 {
			return i.Num, in, out, true
		}
	}
	return 0, 0, 0, false
}

// usbBackend 访问 USB 设备的系统接口（Linux 用 usbfs，测试用假的）
type usbBackend interface {
	// List 当前插着的设备
	List() ([]usbDevice, error)
	// Probe 发 GET_PROTOCOL，返回手机支持的 AOA 协议版本（不支持时返回错误）
	Probe(d usbDevice) (int, error)
	// Switch 发识别字符串并让手机切换到配件模式（手机随后断开重连）
	Switch(d usbDevice, strs [6]string) error
	// Open 打开配件模式的设备，认领配件接口
	Open(d usbDevice) (transport, error)
}

// errPermission 没有权限打开设备节点（/dev/bus/usb/…）
var errPermission = errors.New("没有权限访问这台手机的 USB 设备")
