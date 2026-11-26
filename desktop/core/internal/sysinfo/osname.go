package sysinfo

import (
	"fmt"
	"strings"
)

// windowsName 按版本号得到 Windows 的名字
func windowsName(major, minor, build uint32) string {
	switch {
	case major == 10 && build >= 22000:
		return "Windows 11"
	case major == 10:
		return "Windows 10"
	case major == 6 && minor == 3:
		return "Windows 8.1"
	case major == 6 && minor == 2:
		return "Windows 8"
	case major == 6 && minor == 1:
		return "Windows 7"
	case major == 6 && minor == 0:
		return "Windows Vista"
	case major == 5:
		return "Windows XP"
	}
	return fmt.Sprintf("Windows %d.%d", major, minor)
}

// macName 按 sw_vers 的版本号得到完整名（"macOS 14.5"）和简短名（"macOS 14"；10.x 的大版本是前两段，如 "macOS 10.15"）。
// 旧系统的产品名叫 Mac OS X，这里统一叫 macOS。
func macName(ver string) (full, short string) {
	ver = strings.TrimSpace(ver)
	if ver == "" {
		return "macOS", "macOS"
	}
	parts := strings.Split(ver, ".")
	major := parts[0]
	if major == "10" && len(parts) >= 2 {
		major += "." + parts[1]
	}
	return "macOS " + ver, "macOS " + major
}
