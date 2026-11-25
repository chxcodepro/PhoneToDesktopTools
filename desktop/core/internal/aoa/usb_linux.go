//go:build linux

package aoa

import (
	"errors"
	"fmt"

	"p2d/core/internal/usbio"
)

// Supported 这个系统能不能用免调试连接。Linux 直接用内核的 usbfs，不需要 libusb，龙芯也能用。
const Supported = true

func newBackend() usbBackend { return sysfsBackend{root: usbio.SysfsRoot, dev: usbio.DevRoot} }

type sysfsBackend struct{ root, dev string }

func (b sysfsBackend) List() ([]usbDevice, error) { return usbio.List(b.root) }

func (b sysfsBackend) node(d usbDevice) string { return usbio.Node(b.dev, d) }

const (
	reqTypeVendorIn  = 0xC0 // 设备 → 电脑、厂商请求、接收者为设备
	reqTypeVendorOut = 0x40
)

func getProtocol(h *usbio.Handle) (int, error) {
	b, err := h.Control(reqTypeVendorIn, reqGetProtocol, 0, 0, nil, 2)
	if err != nil {
		return 0, err
	}
	if len(b) < 2 {
		return 0, fmt.Errorf("GET_PROTOCOL 返回了 %d 字节", len(b))
	}
	return int(b[0]) | int(b[1])<<8, nil
}

func (b sysfsBackend) Probe(d usbDevice) (int, error) {
	h, err := usbio.OpenDevice(b.node(d))
	if err != nil {
		return 0, err
	}
	defer h.Close()
	return getProtocol(h)
}

func (b sysfsBackend) Switch(d usbDevice, strs [6]string) error {
	h, err := usbio.OpenDevice(b.node(d))
	if err != nil {
		return err
	}
	defer h.Close()
	v, err := getProtocol(h)
	if err != nil {
		return fmt.Errorf("手机不支持配件模式：%w", err)
	}
	if v < 1 {
		return fmt.Errorf("手机不支持配件模式（协议版本 %d）", v)
	}
	for i, s := range strs {
		if _, err := h.Control(reqTypeVendorOut, reqSendString, 0, uint16(i), append([]byte(s), 0), 0); err != nil {
			return fmt.Errorf("发送识别信息失败：%w", err)
		}
	}
	if _, err := h.Control(reqTypeVendorOut, reqStart, 0, 0, nil, 0); err != nil {
		return fmt.Errorf("切换配件模式失败：%w", err)
	}
	return nil
}

func (b sysfsBackend) Open(d usbDevice) (transport, error) {
	iface, in, out, ok := d.AccessoryEndpoints()
	if !ok {
		return nil, errors.New("没有找到配件接口")
	}
	p, err := usbio.OpenBulk(b.node(d), iface, in, out, usbio.BulkOptions{})
	if errors.Is(err, usbio.ErrBusy) {
		return nil, fmt.Errorf("认领配件接口失败：%w", err)
	}
	return p, err
}
