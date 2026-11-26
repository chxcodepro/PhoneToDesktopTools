package iphone

import (
	"os"
	"path/filepath"
	"strings"
)

// applePresent 插着苹果的 USB 设备（厂商 ID 05ac）：读 sysfs，不需要权限
func applePresent() bool {
	paths, _ := filepath.Glob("/sys/bus/usb/devices/*/idVendor")
	for _, p := range paths {
		if b, err := os.ReadFile(p); err == nil && strings.EqualFold(strings.TrimSpace(string(b)), "05ac") {
			return true
		}
	}
	return false
}
