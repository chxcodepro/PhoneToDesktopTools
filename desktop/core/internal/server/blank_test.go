package server

import (
	"errors"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"p2d/core/internal/tools"
)

type fakeBlank struct {
	mu          sync.Mutex
	unsupported error
	on          bool
	shows       int
}

func (f *fakeBlank) Supported() error { return f.unsupported }
func (f *fakeBlank) Show() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.on = true
	f.shows++
	return nil
}
func (f *fakeBlank) Hide() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.on = false
}
func (f *fakeBlank) isOn() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.on
}

// 两台手机都要求黑屏：一台断开后仍黑屏，都断开才恢复；重复要求不会重复打开
func TestBlankRefCount(t *testing.T) {
	fb := &fakeBlank{}
	s := New(tools.NewRegistry(), NewTokenStore("devtok"))
	s.Blank = fb
	if err := s.setBlank(1, true); err != nil {
		t.Fatal(err)
	}
	if err := s.setBlank(2, true); err != nil {
		t.Fatal(err)
	}
	if err := s.setBlank(1, true); err != nil {
		t.Fatal(err)
	}
	if !fb.isOn() || fb.shows != 1 {
		t.Fatalf("应只打开一次：on=%v shows=%d", fb.on, fb.shows)
	}
	_ = s.setBlank(1, false)
	if !fb.isOn() {
		t.Fatal("还有一台手机要求黑屏，不应恢复")
	}
	_ = s.setBlank(2, false)
	if fb.isOn() {
		t.Fatal("都不要求了应恢复显示")
	}
	if st := s.blankStatus(); st["supported"] != true || st["on"] != false {
		t.Fatalf("状态不对：%v", st)
	}
}

// 不支持的系统：返回原因，状态里带上原因
func TestBlankUnsupported(t *testing.T) {
	s := New(tools.NewRegistry(), NewTokenStore("devtok"))
	s.Blank = &fakeBlank{unsupported: errors.New("需要 Windows 10 2004 及以上")}
	if err := s.setBlank(1, true); err == nil || !strings.Contains(err.Error(), "2004") {
		t.Fatalf("应返回不支持的原因：%v", err)
	}
	if st := s.blankStatus(); st["supported"] != false || st["reason"] == nil {
		t.Fatalf("状态不对：%v", st)
	}
	// 关闭总是成功（手机断开时会调用）
	if err := s.setBlank(1, false); err != nil {
		t.Fatal(err)
	}
}

// 经 MCP 调用：只读权限不能黑屏；手机断开后自动恢复显示
func TestBlankOverSession(t *testing.T) {
	fb := &fakeBlank{}
	srv := New(tools.NewRegistry(), NewTokenStore("devtok"))
	srv.Blank = fb
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	c, _, err := dial(t, ts, "devtok")
	if err != nil {
		t.Fatal(err)
	}
	c.call("initialize", map[string]any{"protocolVersion": "2025-06-18", "clientInfo": map[string]any{"name": "test", "version": "1"}})
	c.call("p2d/setPermissions", map[string]any{"level": "readonly", "shell": false, "fs": false, "screen": true, "input": false})
	if r := c.call("p2d/blank.set", map[string]any{"on": true}); r["error"] == nil || fb.isOn() {
		t.Fatalf("只读权限不应能黑屏：%v", r)
	}
	c.call("p2d/setPermissions", map[string]any{"level": "standard", "shell": false, "fs": false, "screen": true, "input": true})
	if r := c.call("p2d/blank.set", map[string]any{"on": true}); r["error"] != nil || !fb.isOn() {
		t.Fatalf("应打开黑屏：%v", r)
	}
	_ = c.conn.Close()
	waitUntil(t, func() bool { return !fb.isOn() })
}

func waitUntil(t *testing.T, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatal("等待超时")
		}
		time.Sleep(10 * time.Millisecond)
	}
}
