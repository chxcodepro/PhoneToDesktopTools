//go:build windows

package usbio

import (
	"os"
	"testing"
	"unsafe"
)

func TestParseInstanceID(t *testing.T) {
	vid, pid, serial := parseInstanceID(`USB\VID_22D9&PID_2765\3B1F5JE5MS12F371`)
	if vid != 0x22D9 || pid != 0x2765 || serial != "3B1F5JE5MS12F371" {
		t.Fatalf("%#x %#x %q", vid, pid, serial)
	}
	if _, _, serial := parseInstanceID(`USB\VID_18D1&PID_4EE7\6&1DE86D79&0&2`); serial != "" {
		t.Fatalf("按插口生成的 ID 不是序列号：%q", serial)
	}
}

func TestStructSizes(t *testing.T) {
	if unsafe.Sizeof(pipeInfo{}) != 12 || unsafe.Sizeof(usbInterfaceDescriptor{}) != 9 {
		t.Fatalf("WINUSB_PIPE_INFORMATION %d，USB_INTERFACE_DESCRIPTOR %d", unsafe.Sizeof(pipeInfo{}), unsafe.Sizeof(usbInterfaceDescriptor{}))
	}
}

// 真机：P2D_USB_TEST=1 时列出开了 USB 调试的手机并试着打开
func TestRealADBDevices(t *testing.T) {
	if os.Getenv("P2D_USB_TEST") == "" {
		t.Skip("设置 P2D_USB_TEST=1 时运行")
	}
	list, err := ADBDevices()
	if err != nil {
		t.Fatal(err)
	}
	for _, d := range list {
		t.Logf("%+v", d)
		p, err := d.Open()
		if err != nil {
			t.Logf("打开失败：%v", err)
			continue
		}
		t.Logf("已打开")
		p.Close()
	}
}
