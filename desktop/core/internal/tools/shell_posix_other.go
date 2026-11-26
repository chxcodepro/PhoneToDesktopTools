//go:build !darwin

package tools

import "os/exec"

// posixShellName Linux 等系统用 bash 执行命令（Windows 不走这里）。
func posixShellName() string { return "bash" }

func posixShell(command string) *exec.Cmd {
	if p, err := exec.LookPath("bash"); err == nil {
		return exec.Command(p, "-c", command)
	}
	return exec.Command("/bin/sh", "-c", command)
}
