//go:build darwin

package lan

import (
	"os/exec"
	"regexp"
)

var platformUUID = regexp.MustCompile(`"IOPlatformUUID"\s*=\s*"([0-9A-Fa-f-]+)"`)

// systemMachineID Mac 的硬件 UUID（「系统信息」里的「硬件 UUID」），重装系统也不变；取不到时返回空。
func systemMachineID() string {
	out, err := exec.Command("/usr/sbin/ioreg", "-rd1", "-c", "IOPlatformExpertDevice").Output()
	if err != nil {
		return ""
	}
	return parsePlatformUUID(string(out))
}

func parsePlatformUUID(s string) string {
	if m := platformUUID.FindStringSubmatch(s); m != nil {
		return m[1]
	}
	return ""
}
