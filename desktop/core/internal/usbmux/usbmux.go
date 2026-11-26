// Package usbmux 经 usbmuxd 连接 iPhone 上的 TCP 端口（数据线）。
//
// iOS 没有给 App 用的 USB 接口，电脑和 iPhone 之间经数据线通信只能走苹果的 usbmux 协议：
// 电脑上的 usbmuxd 服务负责和 iPhone 打交道，程序连上它之后可以列出插着的 iPhone，
// 并把一条连接接到 iPhone 本机（回环地址）上某个端口，之后这条连接就是普通的字节流。
//
// usbmuxd 由系统提供，P2D 不自带：
//   - macOS：系统自带（/var/run/usbmuxd）；
//   - Windows：装了「Apple 设备」（Microsoft Store）或 iTunes 后才有（Apple Mobile Device Service，127.0.0.1:27015）；
//   - Linux（银河麒麟等）：usbmuxd 软件包（/var/run/usbmuxd），插上 iPhone 时由 udev 启动。
//
// 第一次在一台电脑上使用时，iPhone 上会弹出「要信任此电脑吗？」，点「信任」后才能连接。
// 协议：16 字节小端头（总长度、版本 1、消息类型 8 = plist、标签）+ XML plist。
package usbmux

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"runtime"
	"strings"
	"time"
)

const (
	headerLen   = 16
	protoPlist  = 1
	msgPlist    = 8
	maxResponse = 4 << 20

	// 回复里 Result 的 Number
	resultOK          = 0
	resultBadDevice   = 2
	resultConnRefused = 3
)

var (
	// ErrUnavailable 电脑上没有 usbmuxd（Windows 没装 Apple 设备支持、Linux 没装 usbmuxd）
	ErrUnavailable = errors.New("usbmuxd 不可用")
	// ErrRefused iPhone 上这个端口没有程序在监听（App 没打开或在后台被挂起）
	ErrRefused = errors.New("iPhone 拒绝连接")
	// ErrNoDevice iPhone 已拔出
	ErrNoDevice = errors.New("iPhone 已断开")
)

// Device 插着的 iPhone / iPad
type Device struct {
	ID        int    // usbmuxd 分配的编号，拔插后会变
	Serial    string // UDID
	ProductID int
	USB       bool // 经数据线连接（usbmuxd 也可能列出经 WiFi 同步的设备，这种不用）
}

// address usbmuxd 的地址，可用环境变量 P2D_USBMUXD 覆盖（如 unix:/tmp/usbmuxd、tcp:127.0.0.1:27015）
func address() (network, addr string) {
	if v := os.Getenv("P2D_USBMUXD"); v != "" {
		if n, a, ok := strings.Cut(v, ":"); ok && (n == "unix" || n == "tcp") {
			return n, a
		}
	}
	if runtime.GOOS == "windows" {
		return "tcp", "127.0.0.1:27015"
	}
	return "unix", "/var/run/usbmuxd"
}

func dial() (net.Conn, error) {
	n, a := address()
	c, err := net.DialTimeout(n, a, 3*time.Second)
	if err != nil {
		return nil, fmt.Errorf("%w：%v", ErrUnavailable, err)
	}
	return c, nil
}

// Available 电脑上能不能连上 usbmuxd
func Available() bool {
	c, err := dial()
	if err != nil {
		return false
	}
	_ = c.Close()
	return true
}

func request(c net.Conn, tag uint32, m map[string]any) error {
	m["ClientVersionString"] = "p2d"
	m["ProgName"] = "p2d"
	body, err := encodePlist(m)
	if err != nil {
		return err
	}
	pkt := make([]byte, headerLen+len(body))
	binary.LittleEndian.PutUint32(pkt[0:], uint32(len(pkt)))
	binary.LittleEndian.PutUint32(pkt[4:], protoPlist)
	binary.LittleEndian.PutUint32(pkt[8:], msgPlist)
	binary.LittleEndian.PutUint32(pkt[12:], tag)
	copy(pkt[headerLen:], body)
	_, err = c.Write(pkt)
	return err
}

// response 读一条回复。只读这条消息的字节，不多读：Connect 成功后连接上紧跟着的就是 iPhone 发来的数据。
func response(c net.Conn) (map[string]any, error) {
	var h [headerLen]byte
	if _, err := io.ReadFull(c, h[:]); err != nil {
		return nil, err
	}
	n := binary.LittleEndian.Uint32(h[0:])
	if n < headerLen || n > maxResponse {
		return nil, fmt.Errorf("usbmuxd 回复的长度不对：%d", n)
	}
	body := make([]byte, n-headerLen)
	if _, err := io.ReadFull(c, body); err != nil {
		return nil, err
	}
	if binary.LittleEndian.Uint32(h[8:]) != msgPlist {
		return nil, fmt.Errorf("usbmuxd 回复的消息类型不对：%d", binary.LittleEndian.Uint32(h[8:]))
	}
	v, err := decodePlist(body)
	if err != nil {
		return nil, err
	}
	m := dictOf(v)
	if m == nil {
		return nil, errors.New("usbmuxd 回复的格式不对")
	}
	return m, nil
}

// List 列出插着的设备
func List() ([]Device, error) {
	c, err := dial()
	if err != nil {
		return nil, err
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(5 * time.Second))
	if err := request(c, 1, map[string]any{"MessageType": "ListDevices"}); err != nil {
		return nil, err
	}
	m, err := response(c)
	if err != nil {
		return nil, err
	}
	return parseDeviceList(m), nil
}

func parseDeviceList(m map[string]any) []Device {
	list, _ := m["DeviceList"].([]any)
	out := []Device{}
	for _, it := range list {
		props := dictOf(dictOf(it)["Properties"])
		if props == nil {
			continue
		}
		id, ok := intOf(props["DeviceID"])
		if !ok {
			if id, ok = intOf(dictOf(it)["DeviceID"]); !ok {
				continue
			}
		}
		pid, _ := intOf(props["ProductID"])
		out = append(out, Device{
			ID:        int(id),
			Serial:    stringOf(props["SerialNumber"]),
			ProductID: int(pid),
			USB:       stringOf(props["ConnectionType"]) == "USB",
		})
	}
	return out
}

// Connect 连接 iPhone 本机上的 port 端口，成功后返回的连接就是到那个端口的字节流
func Connect(deviceID, port int) (net.Conn, error) {
	c, err := dial()
	if err != nil {
		return nil, err
	}
	_ = c.SetDeadline(time.Now().Add(5 * time.Second))
	// 端口号按网络字节序（大端）放在整数里
	p := ((port & 0xFF) << 8) | ((port >> 8) & 0xFF)
	if err := request(c, 2, map[string]any{"MessageType": "Connect", "DeviceID": deviceID, "PortNumber": p}); err != nil {
		_ = c.Close()
		return nil, err
	}
	m, err := response(c)
	if err != nil {
		_ = c.Close()
		return nil, err
	}
	n, _ := intOf(m["Number"])
	switch n {
	case resultOK:
		_ = c.SetDeadline(time.Time{})
		return c, nil
	case resultConnRefused:
		_ = c.Close()
		return nil, ErrRefused
	case resultBadDevice:
		_ = c.Close()
		return nil, ErrNoDevice
	default:
		_ = c.Close()
		return nil, fmt.Errorf("usbmuxd 连接失败（代码 %d）", n)
	}
}
