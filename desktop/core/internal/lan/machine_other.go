//go:build !windows

package lan

import "os"

// systemMachineID Linux（含麒麟、统信等）的 systemd / dbus 机器标识；其他系统取不到时返回空。
func systemMachineID() string {
	for _, p := range []string{"/etc/machine-id", "/var/lib/dbus/machine-id"} {
		if b, err := os.ReadFile(p); err == nil && len(b) > 0 {
			return string(b)
		}
	}
	return ""
}
