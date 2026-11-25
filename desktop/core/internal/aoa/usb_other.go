//go:build !linux

package aoa

import "errors"

// Supported 这个系统能不能用免调试连接。
// Windows：手机没开 USB 调试时只有 MTP 接口，被系统的 MTP 驱动占着，电脑发不出切换配件模式的请求，
// 要替换手机驱动或装第三方过滤驱动才行，所以不支持（开 USB 调试走 adb）。
const Supported = false

func newBackend() usbBackend { return unsupported{} }

type unsupported struct{}

var errUnsupported = errors.New("这个系统不支持免调试连接")

func (unsupported) List() ([]usbDevice, error)        { return nil, errUnsupported }
func (unsupported) Probe(usbDevice) (int, error)      { return 0, errUnsupported }
func (unsupported) Switch(usbDevice, [6]string) error { return errUnsupported }
func (unsupported) Open(usbDevice) (transport, error) { return nil, errUnsupported }
