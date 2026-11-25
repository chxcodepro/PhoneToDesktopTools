//go:build linux

package aoa

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

func TestSysfsList(t *testing.T) {
	root := t.TempDir()
	writeAttrs(t, filepath.Join(root, "usb1"), map[string]string{"idVendor": "1d6b", "idProduct": "0002", "busnum": "1", "devnum": "1", "bDeviceClass": "09"})
	writeAttrs(t, filepath.Join(root, "1-2"), map[string]string{
		"idVendor": "18d1", "idProduct": "2d00", "busnum": "1", "devnum": "7", "bDeviceClass": "00",
		"serial": "ABC", "product": "PJZ110", "manufacturer": "OnePlus",
	})
	writeAttrs(t, filepath.Join(root, "1-2:1.0"), map[string]string{"bInterfaceNumber": "00", "bInterfaceClass": "ff", "bInterfaceSubClass": "ff", "bInterfaceProtocol": "00"})
	writeAttrs(t, filepath.Join(root, "1-2:1.0", "ep_81"), map[string]string{"bEndpointAddress": "81", "type": "Bulk"})
	writeAttrs(t, filepath.Join(root, "1-2:1.0", "ep_01"), map[string]string{"bEndpointAddress": "01", "type": "Bulk"})

	list, err := sysfsBackend{root: root, dev: "/dev/bus/usb"}.List()
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 {
		t.Fatalf("应只列出手机：%+v", list)
	}
	d := list[0]
	if !isAccessory(d.VID, d.PID) || d.Serial != "ABC" || d.Bus != 1 || d.Addr != 7 {
		t.Fatalf("设备 %+v", d)
	}
	iface, in, out, ok := d.accessoryEndpoints()
	if !ok || iface != 0 || in != 0x81 || out != 0x01 {
		t.Fatalf("端点 %d %#x %#x %v", iface, in, out, ok)
	}
	if got := (sysfsBackend{dev: "/dev/bus/usb"}).node(d); got != "/dev/bus/usb/001/007" {
		t.Fatalf("设备节点 %s", got)
	}
}
