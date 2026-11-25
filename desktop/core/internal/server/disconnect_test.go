package server

import (
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// 电脑上点「断开」：手机收到专门的关闭码（不再自动重连），而不是普通关闭
func TestDisconnectAllUsesCloseByPC(t *testing.T) {
	ts := newTestServer(t)
	c, _, err := dial(t, ts, "devtok")
	if err != nil {
		t.Fatal(err)
	}
	defer c.conn.Close()
	c.call("initialize", map[string]any{"protocolVersion": "2025-06-18", "clientInfo": map[string]any{"name": "test", "version": "1"}})
	resp, err := http.Post(ts.URL+"/api/disconnect", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	_ = c.conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	for {
		_, _, err := c.conn.ReadMessage()
		if err == nil {
			continue
		}
		var ce *websocket.CloseError
		if !errors.As(err, &ce) {
			t.Fatalf("应收到关闭帧：%v", err)
		}
		if ce.Code != CloseByPC || ce.Text != "电脑端已断开连接" {
			t.Fatalf("关闭码 %d（%s），应为 %d", ce.Code, ce.Text, CloseByPC)
		}
		return
	}
}
