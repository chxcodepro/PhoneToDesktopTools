package aoa

import "p2d/core/internal/usbio"

// USB 设备、接口、端点（Linux 从 /sys/bus/usb/devices 读取，见 internal/usbio）
type (
	usbDevice = usbio.Device
	usbIface  = usbio.Iface
	usbEP     = usbio.EP
)

// 接口类型
const (
	classStill  = usbio.ClassStill
	classVendor = usbio.ClassVendor
)

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
var errPermission = usbio.ErrPermission
