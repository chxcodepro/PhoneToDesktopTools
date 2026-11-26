//go:build darwin

package sysinfo

import (
	"os/exec"
	"strings"
	"sync"
)

var (
	macOnce sync.Once
	macVer  string
)

// macVersion 系统版本号，如 "14.5"（sw_vers 是系统自带的命令，结果缓存起来）
func macVersion() string {
	macOnce.Do(func() {
		if out, err := exec.Command("/usr/bin/sw_vers", "-productVersion").Output(); err == nil {
			macVer = strings.TrimSpace(string(out))
		}
	})
	return macVer
}

// OSVersion 完整的系统版本，如 "macOS 14.5"。
func OSVersion() string {
	full, _ := macName(macVersion())
	return full
}

// OSName 简短的系统名，如 "macOS 14"、"macOS 10.15"（手机端按它显示系统图标）。
func OSName() string {
	_, short := macName(macVersion())
	return short
}
