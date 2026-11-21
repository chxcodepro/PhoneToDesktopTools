//go:build !windows

package tools

import (
	"context"
	"os"
	"os/exec"
	"strings"
	"time"
)

// shQuote 把字符串放进单引号，供 bash -c 使用。
func shQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// shellExecAdmin 以 root 执行：已配置免密 sudo 时直接用 sudo -n，否则用 pkexec 弹出图形密码框（麒麟等桌面自带）。
func shellExecAdmin(ctx context.Context, command, cwd string, timeout time.Duration) (*Result, error) {
	script := "cd " + shQuote(cwd) + " && " + command
	if exec.Command("sudo", "-n", "true").Run() == nil {
		return runCommand(ctx, exec.Command("sudo", "-n", "bash", "-c", script), cwd, timeout, "（以 root 身份执行：sudo）\n"), nil
	}
	if p, err := exec.LookPath("pkexec"); err == nil && (os.Getenv("DISPLAY") != "" || os.Getenv("WAYLAND_DISPLAY") != "") {
		// pkexec 会清空环境变量，工作目录也会变成 /root，所以在脚本里先 cd
		res := runCommand(ctx, exec.Command(p, "bash", "-c", script), cwd, timeout, "（已在电脑上弹出 pkexec 授权框，以 root 身份执行）\n")
		if t := firstText(res); strings.Contains(t, "退出码：126") || strings.Contains(t, "退出码：127") {
			res.Content[0].Text = t + "\n提示：退出码 126/127 通常表示用户取消了授权或电脑上没有运行授权代理（polkit agent）。"
		}
		return res, nil
	}
	res := TextResult("需要 root 权限，但电脑上既没有免密 sudo，也无法弹出 pkexec 授权框（没有图形会话或未安装 pkexec）。" +
		"请让用户在电脑终端里用 sudo 执行这条命令：\n" + command)
	res.IsError = true
	return res, nil
}
