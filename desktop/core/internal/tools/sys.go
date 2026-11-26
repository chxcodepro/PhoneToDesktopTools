package tools

import (
	"context"
	"encoding/json"
	"os"
	"os/user"
	"runtime"

	"p2d/core/internal/perm"
	"p2d/core/internal/screen"
	"p2d/core/internal/sysinfo"
)

func registerSys(r *Registry) {
	r.Add(&Tool{
		Name:        "sys_info",
		Description: "获取电脑基本信息：主机名、操作系统版本、CPU 架构、当前用户、是否管理员、主目录、桌面路径、显示器列表。开始操作电脑前建议先调用。",
		InputSchema: object(map[string]prop{}),
		Category:    perm.CatSys, Kind: perm.Read, Handler: sysInfo,
	})
}

func sysInfo(ctx context.Context, raw json.RawMessage) (*Result, error) {
	host, _ := os.Hostname()
	home, _ := os.UserHomeDir()
	username := ""
	if u, err := user.Current(); err == nil {
		username = u.Username
	}
	info := map[string]any{
		"hostname":   host,
		"os":         runtime.GOOS,
		"os_version": sysinfo.OSVersion(),
		"arch":       runtime.GOARCH,
		"user":       username,
		"home":       home,
		"desktop":    sysinfo.DesktopDir(),
		"shell":      map[bool]string{true: "cmd.exe", false: posixShellName()}[runtime.GOOS == "windows"],
		// 是否已是管理员 / root；否则需要提权的命令要用 shell_exec 的 admin 参数，由用户在电脑上授权
		"admin": sysinfo.IsAdmin(),
	}
	if ds, err := screen.Displays(); err == nil {
		info["displays"] = ds
	} else {
		info["displays_error"] = err.Error()
	}
	b, _ := json.MarshalIndent(info, "", "  ")
	return TextResult(string(b)), nil
}
