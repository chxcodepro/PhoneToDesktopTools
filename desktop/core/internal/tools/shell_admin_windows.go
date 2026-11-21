//go:build windows

package tools

// 以管理员身份执行命令：电脑端平时以普通用户运行，需要提权时用 ShellExecuteEx("runas") 弹出 UAC 授权框。
// 提权后的进程与本进程不共享管道，所以把命令写进临时批处理，由它把输出重定向到文件，结束后再读回来。

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"p2d/core/internal/textenc"
)

// modShell32 / modKernel32 定义在 fs_windows.go
var (
	procShellExecuteExW = modShell32.NewProc("ShellExecuteExW")
	procWideCharToMB    = modKernel32.NewProc("WideCharToMultiByte")
)

// SHELLEXECUTEINFOW（字段顺序和对齐与 C 结构一致，32/64 位均可）
type shellExecuteInfo struct {
	cbSize       uint32
	fMask        uint32
	hwnd         uintptr
	lpVerb       *uint16
	lpFile       *uint16
	lpParameters *uint16
	lpDirectory  *uint16
	nShow        int32
	hInstApp     uintptr
	lpIDList     uintptr
	lpClass      *uint16
	hkeyClass    uintptr
	dwHotKey     uint32
	hIcon        uintptr
	hProcess     syscall.Handle
}

const (
	seeMaskNoCloseProcess = 0x00000040
	seeMaskNoAsync        = 0x00000100
	errorCancelled        = 1223
	cpOEM                 = 1
)

// oemBytes 按控制台代码页（中文系统为 GBK）编码，批处理文件按这个编码读取。
func oemBytes(s string) []byte {
	u, err := syscall.UTF16FromString(s)
	if err != nil || len(u) <= 1 {
		return []byte(s)
	}
	n, _, _ := procWideCharToMB.Call(cpOEM, 0, uintptr(unsafe.Pointer(&u[0])), uintptr(len(u)-1), 0, 0, 0, 0)
	if n == 0 {
		return []byte(s)
	}
	buf := make([]byte, n)
	procWideCharToMB.Call(cpOEM, 0, uintptr(unsafe.Pointer(&u[0])), uintptr(len(u)-1), uintptr(unsafe.Pointer(&buf[0])), n, 0, 0)
	return buf
}

func readLimited(path string, limit int) string {
	b, err := os.ReadFile(path)
	if err != nil || len(b) == 0 {
		return ""
	}
	if len(b) > limit {
		b = append(b[:limit/2:limit/2], append([]byte("\r\n…（中间省略）…\r\n"), b[len(b)-limit/2:]...)...)
	}
	s, _ := textenc.Decode(b)
	return strings.TrimRight(s, "\r\n")
}

// writeAdminScript 写出执行命令的批处理：输出重定向到同目录的 out.txt / err.txt，退出码写入 code.txt。
func writeAdminScript(dir, command, cwd string) (string, error) {
	outFile := filepath.Join(dir, "out.txt")
	errFile := filepath.Join(dir, "err.txt")
	codeFile := filepath.Join(dir, "code.txt")
	bat := filepath.Join(dir, "run.bat")
	// 批处理里 % 需要写成 %%；命令交给 cmd /C 执行，与普通 shell_exec 的语义一致
	const crlf = "\r\n"
	script := "@echo off" + crlf +
		`cd /d "` + cwd + `"` + crlf +
		`cmd.exe /S /C "` + strings.ReplaceAll(command, "%", "%%") + `" > "` + outFile + `" 2> "` + errFile + `"` + crlf +
		`> "` + codeFile + `" echo %errorlevel%` + crlf
	if err := os.WriteFile(bat, oemBytes(script), 0o600); err != nil {
		return "", fmt.Errorf("无法写入临时脚本：%v", err)
	}
	return bat, nil
}

func shellExecAdmin(ctx context.Context, command, cwd string, timeout time.Duration) (*Result, error) {
	dir, err := os.MkdirTemp("", "p2d-admin-")
	if err != nil {
		return nil, fmt.Errorf("无法创建临时目录：%v", err)
	}
	defer os.RemoveAll(dir)
	bat, err := writeAdminScript(dir, command, cwd)
	if err != nil {
		return nil, err
	}
	outFile, errFile, codeFile := filepath.Join(dir, "out.txt"), filepath.Join(dir, "err.txt"), filepath.Join(dir, "code.txt")

	verb, _ := syscall.UTF16PtrFromString("runas")
	file, _ := syscall.UTF16PtrFromString("cmd.exe")
	params, _ := syscall.UTF16PtrFromString(`/D /C "` + bat + `"`)
	wd, _ := syscall.UTF16PtrFromString(dir)
	info := shellExecuteInfo{fMask: seeMaskNoCloseProcess | seeMaskNoAsync, lpVerb: verb, lpFile: file, lpParameters: params, lpDirectory: wd, nShow: 0}
	info.cbSize = uint32(unsafe.Sizeof(info))

	start := time.Now()
	r, _, callErr := procShellExecuteExW.Call(uintptr(unsafe.Pointer(&info)))
	if r == 0 {
		if errno, ok := callErr.(syscall.Errno); ok && errno == errorCancelled {
			return ErrorResult("用户在电脑上拒绝了管理员授权（UAC），命令没有执行。"), nil
		}
		return ErrorResult(fmt.Sprintf("无法请求管理员权限：%v", callErr)), nil
	}
	if info.hProcess == 0 {
		return ErrorResult("已请求管理员权限，但没有拿到进程句柄，无法获取执行结果。"), nil
	}
	defer syscall.CloseHandle(info.hProcess)

	// 分段等待，以便响应取消
	timedOut, canceled := false, false
	deadline := time.Now().Add(timeout)
	for {
		ev, _ := syscall.WaitForSingleObject(info.hProcess, 500)
		if ev == syscall.WAIT_OBJECT_0 {
			break
		}
		if ctx.Err() != nil {
			canceled = true
		} else if time.Now().After(deadline) {
			timedOut = true
		}
		if timedOut || canceled {
			_ = syscall.TerminateProcess(info.hProcess, 1)
			break
		}
	}

	var sb strings.Builder
	sb.WriteString("（已通过 UAC 以管理员身份执行）\n")
	switch {
	case timedOut:
		fmt.Fprintf(&sb, "超时（%v）已结束进程\n", timeout)
	case canceled:
		sb.WriteString("已取消\n")
	}
	code := -1
	if b, err := os.ReadFile(codeFile); err == nil {
		if n, err := strconv.Atoi(strings.TrimSpace(string(b))); err == nil {
			code = n
		}
	}
	fmt.Fprintf(&sb, "退出码：%d（耗时 %.1f 秒，目录 %s）\n", code, time.Since(start).Seconds(), cwd)
	if out := readLimited(outFile, shellMaxOutput); out != "" {
		sb.WriteString("--- 标准输出 ---\n" + out + "\n")
	}
	if e := readLimited(errFile, shellMaxOutput/2); e != "" {
		sb.WriteString("--- 错误输出 ---\n" + e + "\n")
	}
	res := TextResult(sb.String())
	res.IsError = timedOut || canceled
	return res, nil
}
