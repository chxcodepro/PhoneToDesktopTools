package tools

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"time"

	"p2d/core/internal/perm"
	"p2d/core/internal/procutil"
	"p2d/core/internal/sysinfo"
	"p2d/core/internal/textenc"
)

const shellMaxOutput = 100 * 1024

func registerShell(r *Registry) {
	shellName := "bash"
	if runtime.GOOS == "windows" {
		shellName = "cmd.exe"
	}
	r.Add(&Tool{
		Name: "shell_exec",
		Description: "在电脑上执行命令并返回退出码和输出（当前系统使用 " + shellName + "）。" +
			"适合查询信息、运行脚本、启动程序。不要执行需要交互输入的命令；启动 GUI 程序时，Windows 用 `start \"\" 程序`，Linux 在命令末尾加 `&`。" +
			"需要管理员 / root 权限的命令（启停系统服务、安装驱动、写系统目录、重置网络等）设置 admin 为 true：" +
			"电脑上会弹出系统授权框（Windows UAC，Linux 为 pkexec 密码框），需要用户在电脑上确认。",
		InputSchema: object(map[string]prop{
			"command":     str("要执行的命令"),
			"cwd":         str("工作目录，默认为用户主目录"),
			"timeout_sec": intg("超时秒数，默认 60，最大 600"),
			"admin":       boolean("以管理员 / root 身份执行（会请求用户在电脑上授权）"),
		}, "command"),
		Category: perm.CatShell,
		Kind:     perm.Dangerous,
		Handler:  shellExec,
	})
}

// limitedBuffer 只保留前一部分和最后一部分输出，防止内存暴涨。
type limitedBuffer struct {
	mu      sync.Mutex
	head    bytes.Buffer
	tail    []byte
	dropped int
	limit   int
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	n := len(p)
	headLimit := b.limit / 2
	if room := headLimit - b.head.Len(); room > 0 {
		if room > len(p) {
			room = len(p)
		}
		b.head.Write(p[:room])
		p = p[room:]
	}
	if len(p) > 0 {
		b.tail = append(b.tail, p...)
		tailLimit := b.limit - headLimit
		if over := len(b.tail) - tailLimit; over > 0 {
			b.dropped += over
			b.tail = append(b.tail[:0], b.tail[over:]...)
		}
	}
	return n, nil
}

func (b *limitedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	head, _ := textenc.Decode(b.head.Bytes())
	if b.dropped == 0 {
		tail, _ := textenc.Decode(b.tail)
		return head + tail
	}
	tail, _ := textenc.Decode(b.tail)
	return head + fmt.Sprintf("\n…（中间省略 %d 字节）…\n", b.dropped) + tail
}

func shellCommand(command string) *exec.Cmd {
	if runtime.GOOS == "windows" {
		cmd := exec.Command("cmd.exe")
		// 直接传入原始命令行，避免 Go 对引号再次转义导致 cmd 解析错误
		setRawCmdLine(cmd, `cmd.exe /S /C "`+command+`"`)
		return cmd
	}
	if p, err := exec.LookPath("bash"); err == nil {
		return exec.Command(p, "-c", command)
	}
	return exec.Command("/bin/sh", "-c", command)
}

func shellExec(ctx context.Context, raw json.RawMessage) (*Result, error) {
	var a struct {
		Command    string `json:"command"`
		Cwd        string `json:"cwd"`
		TimeoutSec int    `json:"timeout_sec"`
		Admin      bool   `json:"admin"`
	}
	if err := decode(raw, &a); err != nil {
		return nil, err
	}
	if strings.TrimSpace(a.Command) == "" {
		return nil, errors.New("command 不能为空")
	}
	timeout := 60 * time.Second
	if a.TimeoutSec > 0 {
		if a.TimeoutSec > 600 {
			a.TimeoutSec = 600
		}
		timeout = time.Duration(a.TimeoutSec) * time.Second
	}
	cwd := a.Cwd
	if cwd == "" {
		cwd, _ = os.UserHomeDir()
	} else {
		cwd = resolvePath(cwd)
	}

	if a.Admin && !sysinfo.IsAdmin() {
		return shellExecAdmin(ctx, a.Command, cwd, timeout)
	}
	return runCommand(ctx, shellCommand(a.Command), cwd, timeout, ""), nil
}

// runCommand 执行命令并把退出码、标准输出、错误输出整理成结果。note 显示在结果开头。
func runCommand(ctx context.Context, cmd *exec.Cmd, cwd string, timeout time.Duration, note string) *Result {
	cmd.Dir = cwd
	stdout := &limitedBuffer{limit: shellMaxOutput}
	stderr := &limitedBuffer{limit: shellMaxOutput / 2}
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	cmd.Stdin = nil
	cmd.WaitDelay = 3 * time.Second // 后台子进程占用管道时不至于一直卡住
	procutil.Prepare(cmd)

	start := time.Now()
	if err := cmd.Start(); err != nil {
		res := TextResult(note + fmt.Sprintf("无法启动命令：%v", err))
		res.IsError = true
		return res
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()

	var waitErr error
	timedOut, canceled := false, false
	select {
	case waitErr = <-done:
	case <-time.After(timeout):
		timedOut = true
		procutil.KillTree(cmd)
		waitErr = <-done
	case <-ctx.Done():
		canceled = true
		procutil.KillTree(cmd)
		waitErr = <-done
	}

	exitCode := 0
	if cmd.ProcessState != nil {
		exitCode = cmd.ProcessState.ExitCode()
	}
	var sb strings.Builder
	sb.WriteString(note)
	switch {
	case timedOut:
		fmt.Fprintf(&sb, "超时（%v）已结束进程\n", timeout)
	case canceled:
		sb.WriteString("已取消\n")
	case waitErr != nil && !errors.As(waitErr, new(*exec.ExitError)) && !errors.Is(waitErr, exec.ErrWaitDelay):
		fmt.Fprintf(&sb, "执行出错：%v\n", waitErr)
	}
	fmt.Fprintf(&sb, "退出码：%d（耗时 %.1f 秒，目录 %s）\n", exitCode, time.Since(start).Seconds(), cwd)
	if out := stdout.String(); out != "" {
		sb.WriteString("--- 标准输出 ---\n")
		sb.WriteString(strings.TrimRight(out, "\r\n"))
		sb.WriteString("\n")
	}
	if errOut := stderr.String(); errOut != "" {
		sb.WriteString("--- 错误输出 ---\n")
		sb.WriteString(strings.TrimRight(errOut, "\r\n"))
		sb.WriteString("\n")
	}
	res := TextResult(sb.String())
	res.IsError = timedOut || canceled
	return res
}

func firstText(r *Result) string {
	if r == nil || len(r.Content) == 0 {
		return ""
	}
	return r.Content[0].Text
}
