//go:build !windows && !darwin

package sysinfo

import (
	"bufio"
	"os"
	"strings"
)

// OSVersion 读取 /etc/os-release，例如 "Kylin V10 SP1"。
func OSVersion() string {
	f, err := os.Open("/etc/os-release")
	if err != nil {
		return "Linux"
	}
	defer f.Close()
	vals := map[string]string{}
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		k, v, ok := strings.Cut(sc.Text(), "=")
		if ok {
			vals[k] = strings.Trim(v, `"'`)
		}
	}
	if v := vals["PRETTY_NAME"]; v != "" {
		return v
	}
	if v := vals["NAME"] + " " + vals["VERSION"]; strings.TrimSpace(v) != "" {
		return strings.TrimSpace(v)
	}
	return "Linux"
}

// OSName 简短的系统名，如 "Kylin V10 SP1"、"UOS 20"（手机端按它显示系统图标）。
func OSName() string { return OSVersion() }
