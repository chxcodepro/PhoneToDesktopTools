//go:build linux

package usbio

import (
	"os"
	"path/filepath"
	"testing"
	"unsafe"
)

// ioctl 编号要和内核头文件 linux/usbdevice_fs.h 算出来的一致
func TestIoctlNumbers(t *testing.T) {
	if unsafe.Sizeof(uintptr(0)) == 8 {
		if ioctlControl != 0xC0185500 || ioctlBulk != 0xC0185502 {
			t.Fatalf("64 位：CONTROL=%#x BULK=%#x", ioctlControl, ioctlBulk)
		}
	} else if ioctlControl != 0xC0105500 || ioctlBulk != 0xC0105502 {
		t.Fatalf("32 位：CONTROL=%#x BULK=%#x", ioctlControl, ioctlBulk)
	}
	if ioctlClaim != 0x8004550F || ioctlRelease != 0x80045510 {
		t.Fatalf("CLAIM=%#x RELEASE=%#x", ioctlClaim, ioctlRelease)
	}
}

func writeAttrs(t *testing.T, dir string, attrs map[string]string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	for k, v := range attrs {
		if err := os.WriteFile(filepath.Join(dir, k), []byte(v+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

// 开了 USB 调试的手机：接口 0 是 MTP，接口 1 是 ADB
func TestListADB(t *testing.T) {
	root := t.TempDir()
	writeAttrs(t, filepath.Join(root, "usb1"), map[string]string{"idVendor": "1d6b", "idProduct": "0002", "busnum": "1", "devnum": "1", "bDeviceClass": "09"})
	writeAttrs(t, filepath.Join(root, "1-2"), map[string]string{
		"idVendor": "22d9", "idProduct": "2765", "busnum": "1", "devnum": "9", "bDeviceClass": "00",
		"serial": "3B1F5JE5MS12F371", "product": "PJZ110",
	})
	writeAttrs(t, filepath.Join(root, "1-2:1.0"), map[string]string{"bInterfaceNumber": "00", "bInterfaceClass": "06", "bInterfaceSubClass": "01", "bInterfaceProtocol": "01"})
	writeAttrs(t, filepath.Join(root, "1-2:1.1"), map[string]string{"bInterfaceNumber": "01", "bInterfaceClass": "ff", "bInterfaceSubClass": "42", "bInterfaceProtocol": "01"})
	writeAttrs(t, filepath.Join(root, "1-2:1.1", "ep_82"), map[string]string{"bEndpointAddress": "82", "type": "Bulk", "wMaxPacketSize": "0200"})
	writeAttrs(t, filepath.Join(root, "1-2:1.1", "ep_02"), map[string]string{"bEndpointAddress": "02", "type": "Bulk", "wMaxPacketSize": "0200"})

	list, err := List(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 {
		t.Fatalf("应只列出手机：%+v", list)
	}
	d := list[0]
	if !d.HasADB() || !d.MaybePhone() || d.Serial != "3B1F5JE5MS12F371" {
		t.Fatalf("设备 %+v", d)
	}
	iface, in, out, mp, ok := d.ADBEndpoints()
	if !ok || iface != 1 || in != 0x82 || out != 0x02 || mp != 512 {
		t.Fatalf("端点 %d %#x %#x %d %v", iface, in, out, mp, ok)
	}
	if _, _, _, ok := d.AccessoryEndpoints(); ok {
		t.Fatal("不是配件模式")
	}
	if got := Node("/dev/bus/usb", d); got != "/dev/bus/usb/001/009" {
		t.Fatalf("设备节点 %s", got)
	}
}
