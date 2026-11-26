//go:build darwin

package tools

import (
	"os"
	"os/exec"
)

// Mac 默认的 shell 是 zsh（10.15 起；10.13、10.14 也自带 /bin/zsh），没有时用 bash。
// 用登录 shell（-l）执行：从「访达」或开机自启打开的程序 PATH 只有系统目录，登录 shell 会读 /etc/zprofile、~/.zprofile，
// 加上 /usr/local/bin、Homebrew 等用户平时在终端里能用的命令目录。
func macShell() string {
	if _, err := os.Stat("/bin/zsh"); err == nil {
		return "/bin/zsh"
	}
	return "/bin/bash"
}

func posixShellName() string {
	if macShell() == "/bin/zsh" {
		return "zsh"
	}
	return "bash"
}

func posixShell(command string) *exec.Cmd {
	return exec.Command(macShell(), "-l", "-c", command)
}
