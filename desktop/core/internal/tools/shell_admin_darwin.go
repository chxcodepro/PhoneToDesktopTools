//go:build darwin

package tools

import (
	"context"
	"os/exec"
	"strings"
	"time"
)

// shQuote 把字符串放进单引号，供 sh -c 使用。
func shQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// appleScriptString 把字符串写成 AppleScript 的字符串字面量（反斜杠和双引号要转义）。
func appleScriptString(s string) string {
	s = strings.ReplaceAll(s, `\`, `\`)
	s = strings.ReplaceAll(s, `"`, `\"`)
	return `"` + s + `"`
}

// adminAppleScript 生成以管理员身份执行命令的 AppleScript：系统弹出密码框（支持触控 ID），用户确认后以 root 执行。
// do shell script 用 /bin/sh 执行，这里先 cd 到工作目录；without altering line endings 保留原来的换行（默认会把 \n 换成 \r）。
func adminAppleScript(command, cwd string) string {
	script := "cd " + shQuote(cwd) + " && " + command
	return "do shell script " + appleScriptString(script) + " with administrator privileges without altering line endings"
}

// shellExecAdmin 以 root 执行：已配置免密 sudo 时直接用 sudo -n，否则用 osascript 弹出系统的管理员密码框。
func shellExecAdmin(ctx context.Context, command, cwd string, timeout time.Duration) (*Result, error) {
	if exec.Command("sudo", "-n", "true").Run() == nil {
		script := "cd " + shQuote(cwd) + " && " + command
		return runCommand(ctx, exec.Command("sudo", "-n", "/bin/zsh", "-c", script), cwd, timeout, "（以 root 身份执行：sudo）\n"), nil
	}
	res := runCommand(ctx, exec.Command("/usr/bin/osascript", "-e", adminAppleScript(command, cwd)), cwd, timeout,
		"（已在电脑上弹出管理员密码框，以 root 身份执行）\n")
	if t := firstText(res); strings.Contains(t, "-128") {
		res.Content[0].Text = t + "\n提示：-128 表示用户在电脑上取消了授权。"
	}
	return res, nil
}
