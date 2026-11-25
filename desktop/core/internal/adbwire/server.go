package adbwire

// 电脑上已经有 adb 后台服务（Android Studio、用户自己装的 adb）在运行时，它会占住手机的 USB 调试接口，
// 我们直接连不上。这时经它的 5037 端口办事（adb 客户端协议，见 AOSP 的 SERVICES.TXT）：
// 请求是「4 位十六进制长度 + 内容」，回复 OKAY，或 FAIL + 4 位长度 + 原因。

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"time"
)

// ServerAddr adb 后台服务的地址
var ServerAddr = "127.0.0.1:5037"

// ErrNoServer 没有 adb 后台服务在运行
var ErrNoServer = errors.New("没有 adb 后台服务在运行")

func dialServer(ctx context.Context) (net.Conn, error) {
	d := net.Dialer{Timeout: time.Second}
	c, err := d.DialContext(ctx, "tcp", ServerAddr)
	if err != nil {
		return nil, ErrNoServer
	}
	if dl, ok := ctx.Deadline(); ok {
		_ = c.SetDeadline(dl)
	}
	return c, nil
}

func readStatus(c net.Conn) error {
	var st [4]byte
	if _, err := io.ReadFull(c, st[:]); err != nil {
		return err
	}
	switch string(st[:]) {
	case "OKAY":
		return nil
	case "FAIL":
		msg, err := readHexString(c)
		if err != nil {
			return errors.New("adb 服务返回失败")
		}
		return fmt.Errorf("adb 服务：%s", msg)
	}
	return fmt.Errorf("adb 服务返回了 %q", st[:])
}

func readHexString(r io.Reader) (string, error) {
	var l [4]byte
	if _, err := io.ReadFull(r, l[:]); err != nil {
		return "", err
	}
	n, err := strconv.ParseUint(string(l[:]), 16, 16)
	if err != nil {
		return "", err
	}
	b := make([]byte, n)
	if _, err := io.ReadFull(r, b); err != nil {
		return "", err
	}
	return string(b), nil
}

func request(c net.Conn, req string) error {
	if _, err := fmt.Fprintf(c, "%04x%s", len(req), req); err != nil {
		return err
	}
	return readStatus(c)
}

// ServerDevice adb 后台服务列出的一台设备
type ServerDevice struct {
	Serial string
	State  string // device / unauthorized / offline …
	Model  string
}

// ServerDevices 问 adb 后台服务有哪些设备；没有服务在运行时返回 ErrNoServer
func ServerDevices(ctx context.Context) ([]ServerDevice, error) {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	c, err := dialServer(ctx)
	if err != nil {
		return nil, err
	}
	defer c.Close()
	if err := request(c, "host:devices-l"); err != nil {
		return nil, err
	}
	s, err := readHexString(c)
	if err != nil {
		return nil, err
	}
	return parseDevices(s), nil
}

// parseDevices 解析 adb devices -l 的输出
func parseDevices(out string) []ServerDevice {
	var res []ServerDevice
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		// 跳过提示行：「* daemon started」、「adb server version (41) doesn't match this client (39); killing...」等
		if line == "" || strings.HasPrefix(line, "List of devices") || strings.HasPrefix(line, "*") || strings.HasPrefix(line, "adb ") || strings.HasPrefix(line, "adb:") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		d := ServerDevice{Serial: fields[0], State: fields[1]}
		for _, f := range fields[2:] {
			if v, ok := strings.CutPrefix(f, "model:"); ok {
				d.Model = strings.ReplaceAll(v, "_", " ")
			}
		}
		res = append(res, d)
	}
	return res
}

// ServerDisconnect 断开 adb 服务的一个网络设备（adb disconnect）
func ServerDisconnect(ctx context.Context, serial string) error {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	c, err := dialServer(ctx)
	if err != nil {
		return err
	}
	defer c.Close()
	return request(c, "host:disconnect:"+serial)
}

// Server 经 adb 后台服务访问的一台设备
type Server struct{ Serial string }

// Open 打开设备上的服务。ctx 只管到打开为止，之后的读写由调用方控制（见 services.go 的 watch）。
func (s Server) Open(ctx context.Context, service string) (io.ReadWriteCloser, error) {
	c, err := dialServer(ctx)
	if err != nil {
		return nil, err
	}
	if err := request(c, "host:transport:"+s.Serial); err != nil {
		c.Close()
		return nil, err
	}
	if err := request(c, service); err != nil {
		c.Close()
		return nil, err
	}
	_ = c.SetDeadline(time.Time{})
	return c, nil
}
