//go:build windows

package tools

import (
	"os/exec"
	"syscall"
)

// setRawCmdLine 让 cmd.exe 收到未经 Go 转义的原始命令行。
func setRawCmdLine(cmd *exec.Cmd, line string) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.CmdLine = line
}
