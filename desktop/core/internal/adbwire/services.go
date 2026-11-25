package adbwire

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
)

// watch ctx 结束时关闭 rwc，正在进行的读写随之返回。返回的函数在用完后调用。
func watch(ctx context.Context, rwc io.Closer) func() {
	done := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			rwc.Close()
		case <-done:
		}
	}()
	return func() { close(done) }
}

func readAll(ctx context.Context, rwc io.ReadWriteCloser) (string, error) {
	defer rwc.Close()
	stop := watch(ctx, rwc)
	defer stop()
	var out bytes.Buffer
	_, err := io.Copy(&out, rwc)
	if ctx.Err() != nil {
		return out.String(), ctx.Err()
	}
	if err != nil && !errors.Is(err, io.EOF) {
		return out.String(), err
	}
	return out.String(), nil
}

// Shell 在手机上执行命令，返回输出（标准输出和错误输出合在一起，去掉首尾空白）。
// 命令交给手机上的 sh 执行，参数里的特殊字符要自己用单引号包住。
func Shell(ctx context.Context, o Opener, cmd string) (string, error) {
	s, err := o.Open(ctx, "shell:"+cmd)
	if err != nil {
		return "", err
	}
	out, err := readAll(ctx, s)
	return strings.TrimSpace(out), err
}

// Install 安装（覆盖安装）APK，返回手机的输出，成功时含 Success。
// 用 cmd package install -S 把安装包直接传给手机的软件包服务（Android 7.0 起支持），不用先存到手机上。
func Install(ctx context.Context, o Opener, apkPath string) (string, error) {
	f, err := os.Open(apkPath)
	if err != nil {
		return "", err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return "", err
	}
	s, err := o.Open(ctx, fmt.Sprintf("exec:cmd package install -r -S %d", st.Size()))
	if err != nil {
		return "", err
	}
	stop := watch(ctx, s)
	_, err = io.Copy(s, f)
	stop()
	if err != nil {
		s.Close()
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		return "", fmt.Errorf("传送安装包失败：%w", err)
	}
	out, err := readAll(ctx, s)
	return strings.TrimSpace(out), err
}

// reverser 直连的 Conn 要知道哪些手机发起的连接是允许的
type reverser interface {
	allowReverse(dest, addr string)
	disallowReverse(dest string)
}

// serviceStatus 解析 reverse 等服务的回复：OKAY[...] 或 FAIL + 4 位长度 + 原因。手机可能连着回两个 OKAY。
func serviceStatus(out string) (string, error) {
	if rest, ok := strings.CutPrefix(out, "FAIL"); ok {
		if len(rest) >= 4 {
			if n, err := strconv.ParseUint(rest[:4], 16, 16); err == nil && int(n) <= len(rest)-4 {
				return "", fmt.Errorf("手机返回：%s", rest[4:4+n])
			}
		}
		return "", fmt.Errorf("手机返回：%s", rest)
	}
	if !strings.HasPrefix(out, "OKAY") {
		return "", fmt.Errorf("手机返回了 %q", out)
	}
	for strings.HasPrefix(out, "OKAY") {
		out = out[4:]
	}
	return out, nil
}

// Reverse 把手机上的 tcp:port 转到电脑上的同一端口（adb reverse tcp:port tcp:port）
func Reverse(ctx context.Context, o Opener, port int) error {
	spec := fmt.Sprintf("tcp:%d", port)
	if r, ok := o.(reverser); ok {
		r.allowReverse(spec, fmt.Sprintf("127.0.0.1:%d", port))
	}
	s, err := o.Open(ctx, "reverse:forward:"+spec+";"+spec)
	if err != nil {
		return err
	}
	out, err := readAll(ctx, s)
	if err != nil {
		return err
	}
	_, err = serviceStatus(out)
	return err
}

// ReverseList 已建立的反向转发（adb reverse --list 的输出）
func ReverseList(ctx context.Context, o Opener) (string, error) {
	s, err := o.Open(ctx, "reverse:list-forward")
	if err != nil {
		return "", err
	}
	out, err := readAll(ctx, s)
	if err != nil {
		return "", err
	}
	// 手机直接回「4 位长度 + 列表」，经 adb 服务时前面还有 OKAY
	rest := out
	if strings.HasPrefix(out, "OKAY") || strings.HasPrefix(out, "FAIL") {
		if rest, err = serviceStatus(out); err != nil {
			return "", err
		}
	}
	if len(rest) >= 4 {
		if n, err := strconv.ParseUint(rest[:4], 16, 16); err == nil && int(n) <= len(rest)-4 {
			return rest[4 : 4+n], nil
		}
	}
	return rest, nil
}

// ReverseRemove 去掉反向转发
func ReverseRemove(ctx context.Context, o Opener, port int) error {
	spec := fmt.Sprintf("tcp:%d", port)
	if r, ok := o.(reverser); ok {
		r.disallowReverse(spec)
	}
	s, err := o.Open(ctx, "reverse:killforward:"+spec)
	if err != nil {
		return err
	}
	out, err := readAll(ctx, s)
	if err != nil {
		return err
	}
	_, err = serviceStatus(out)
	return err
}
