//go:build windows

// Package procutil 封装子进程的平台差异：隐藏控制台窗口、结束整个进程树。
package procutil

import (
	"os/exec"
	"strconv"
	"syscall"
)

const createNoWindow = 0x08000000

// Prepare 隐藏子进程的控制台窗口。必须在 Start 之前调用。
func Prepare(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.HideWindow = true
	cmd.SysProcAttr.CreationFlags |= createNoWindow
}

// KillTree 结束进程及其所有子进程（cmd /C 启动的孙进程也要结束）。
func KillTree(cmd *exec.Cmd) {
	if cmd.Process == nil {
		return
	}
	k := exec.Command("taskkill", "/T", "/F", "/PID", strconv.Itoa(cmd.Process.Pid))
	Prepare(k)
	_ = k.Run()
	_ = cmd.Process.Kill()
}
