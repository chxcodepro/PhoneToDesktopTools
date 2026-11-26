//go:build !windows

// Package sysinfo 获取系统版本、桌面目录等信息。
package sysinfo

import (
	"bufio"
	"os"
	"path/filepath"
	"strings"
)

// DesktopDir 按 XDG 用户目录配置获取桌面（中文系统通常是 ~/桌面）。
func DesktopDir() string {
	home, _ := os.UserHomeDir()
	cfg := os.Getenv("XDG_CONFIG_HOME")
	if cfg == "" {
		cfg = filepath.Join(home, ".config")
	}
	if f, err := os.Open(filepath.Join(cfg, "user-dirs.dirs")); err == nil {
		defer f.Close()
		sc := bufio.NewScanner(f)
		for sc.Scan() {
			line := strings.TrimSpace(sc.Text())
			if v, ok := strings.CutPrefix(line, "XDG_DESKTOP_DIR="); ok {
				v = strings.Trim(v, `"`)
				v = strings.Replace(v, "$HOME", home, 1)
				return v
			}
		}
	}
	for _, name := range []string{"桌面", "Desktop"} {
		p := filepath.Join(home, name)
		if st, err := os.Stat(p); err == nil && st.IsDir() {
			return p
		}
	}
	return filepath.Join(home, "Desktop")
}

// IsAdmin 当前进程是否以 root 身份运行。
func IsAdmin() bool { return os.Geteuid() == 0 }
