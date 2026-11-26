//go:build darwin && !cgo

package usbio

// macOS 的 USB 直连要用 cgo 调 IOKit（见 usbio_darwin.go）；不带 cgo 编译时（如在别的系统上交叉编译检查）不支持。

// Supported 这个系统能不能直接访问 USB 设备。
const Supported = false

// ADBDevices 不带 cgo 编译时不支持
func ADBDevices() ([]ADBDevice, error) { return nil, ErrUnsupported }

// Open 不带 cgo 编译时不支持
func (d ADBDevice) Open() (Pipe, error) { return nil, ErrUnsupported }
