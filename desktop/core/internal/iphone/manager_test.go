package iphone

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"net"
	"sync"
	"testing"
	"time"

	"p2d/core/internal/usbmux"
)

type fakeTokens struct {
	mu      sync.Mutex
	revoked []string
}

func (f *fakeTokens) Issue(serial string) string { return "tok-" + serial }
func (f *fakeTokens) Revoke(serial string) {
	f.mu.Lock()
	f.revoked = append(f.revoked, serial)
	f.mu.Unlock()
}

// 帧格式和 internal/aoa/frame.go 一致
func frame(typ byte, id uint32, payload []byte) []byte {
	b := make([]byte, 8+len(payload))
	b[0], b[1] = 0xA5, typ
	binary.BigEndian.PutUint32(b[2:], id)
	binary.BigEndian.PutUint16(b[6:], uint16(len(payload)))
	copy(b[8:], payload)
	return b
}

func readFrame(t *testing.T, r io.Reader) (byte, uint32, []byte) {
	t.Helper()
	var h [8]byte
	if _, err := io.ReadFull(r, h[:]); err != nil {
		t.Fatal(err)
	}
	p := make([]byte, binary.BigEndian.Uint16(h[6:]))
	if _, err := io.ReadFull(r, p); err != nil {
		t.Fatal(err)
	}
	return h[1], binary.BigEndian.Uint32(h[2:]), p
}

func TestIPhoneLink(t *testing.T) {
	old := pollInterval
	pollInterval = 20 * time.Millisecond
	defer func() { pollInterval = old }()

	// 电脑本机服务：回显
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() { _, _ = io.Copy(c, c); c.Close() }()
		}
	}()

	pcSide, phone := net.Pipe()
	defer phone.Close()
	var mu sync.Mutex
	devs := []usbmux.Device{{ID: 7, Serial: "UDID1", USB: true}, {ID: 8, Serial: "WIFI", USB: false}}
	connects := 0
	tokens := &fakeTokens{}
	m := New(Config{Port: ln.Addr().(*net.TCPAddr).Port, HostName: "PC", PCID: "pc1"}, tokens)
	m.list = func() ([]usbmux.Device, error) {
		mu.Lock()
		defer mu.Unlock()
		return append([]usbmux.Device(nil), devs...), nil
	}
	m.connect = func(id, port int) (net.Conn, error) {
		mu.Lock()
		defer mu.Unlock()
		if id != 7 || port != PhonePort {
			t.Errorf("连接参数不对：%d %d", id, port)
		}
		connects++
		if connects == 1 {
			return nil, usbmux.ErrRefused // 第一次 App 还没打开
		}
		if connects == 2 {
			return pcSide, nil
		}
		return nil, usbmux.ErrRefused
	}
	var gone []string
	m.OnGone = func(s string) {
		mu.Lock()
		gone = append(gone, s)
		mu.Unlock()
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go m.Run(ctx)

	// 手机：握手，收到令牌
	hello, _ := json.Marshal(map[string]any{"v": 1, "nonce": "n1", "name": "我的 iPhone", "app": "1.0"})
	if _, err := phone.Write(frame(1, 0, hello)); err != nil {
		t.Fatal(err)
	}
	typ, _, p := readFrame(t, phone)
	if typ != 2 {
		t.Fatalf("应收到连接参数，收到类型 %d", typ)
	}
	var cfg map[string]any
	_ = json.Unmarshal(p, &cfg)
	if cfg["token"] != "tok-ios:UDID1" || cfg["host"] != "PC" || cfg["nonce"] != "n1" || cfg["pcid"] != "pc1" {
		t.Fatalf("连接参数不对：%v", cfg)
	}

	// 手机上开一个流，经电脑的本机服务回显
	_, _ = phone.Write(frame(4, 1, nil))
	_, _ = phone.Write(frame(5, 1, []byte("ping")))
	got := ""
	for got != "ping" {
		typ, id, p := readFrame(t, phone)
		if typ == 5 && id == 1 {
			got += string(p)
		}
	}

	waitFor(t, func() bool {
		s := m.Snapshot()
		return len(s) == 1 && s[0].Stage == StageReady && s[0].Model == "我的 iPhone" && s[0].Platform == "ios"
	})

	// 电脑上点断开：不再发参数
	m.SuppressAll()
	if s := m.Snapshot(); s[0].Stage != StageSuppressed {
		t.Fatalf("断开后应为 suppressed：%+v", s)
	}

	// 拔线：设备消失，令牌作废，会话断开
	mu.Lock()
	devs = nil
	mu.Unlock()
	waitFor(t, func() bool { return len(m.Snapshot()) == 0 })
	mu.Lock()
	defer mu.Unlock()
	if len(gone) != 1 || gone[0] != "ios:UDID1" {
		t.Fatalf("拔线应断开会话：%v", gone)
	}
}

func TestMissingUsbmuxd(t *testing.T) {
	m := New(Config{}, &fakeTokens{})
	m.list = func() ([]usbmux.Device, error) { return nil, usbmux.ErrUnavailable }
	m.present = func() bool { return false }
	m.poll(context.Background())
	if m.Problem() != "" {
		t.Fatal("没插 iPhone 时不应提示")
	}
	m.present = func() bool { return true }
	m.poll(context.Background())
	if m.Problem() == "" {
		t.Fatal("插着 iPhone 但没有 usbmuxd 时应提示安装")
	}
}

func waitFor(t *testing.T, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatal("等待超时")
		}
		time.Sleep(10 * time.Millisecond)
	}
}
