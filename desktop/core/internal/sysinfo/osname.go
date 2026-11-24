package sysinfo

import "fmt"

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
