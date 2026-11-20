//go:build !windows

package tools

import "os/exec"

func setRawCmdLine(cmd *exec.Cmd, line string) {}
