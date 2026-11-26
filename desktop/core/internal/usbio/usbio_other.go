//go:build !linux && !windows && !darwin

package usbio

// Supported 这个系统能不能直接访问 USB 设备。
const Supported = false

// ADBDevices 这个系统不支持
func ADBDevices() ([]ADBDevice, error) { return nil, ErrUnsupported }

// Open 这个系统不支持
func (d ADBDevice) Open() (Pipe, error) { return nil, ErrUnsupported }
