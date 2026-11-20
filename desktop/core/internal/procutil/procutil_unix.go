//go:build !windows

// Package procutil 封装子进程的平台差异：隐藏控制台窗口、结束整个进程树。
package procutil

import (
	"os/exec"
	"syscall"
)

// Prepare 让子进程成为新进程组的组长，便于整组结束。必须在 Start 之前调用。
func Prepare(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Setpgid = true
}

// KillTree 结束整个进程组。
func KillTree(cmd *exec.Cmd) {
	if cmd.Process == nil {
		return
	}
	_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	_ = cmd.Process.Kill()
}
