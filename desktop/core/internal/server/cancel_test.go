package server

import (
	"runtime"
	"strings"
	"testing"
	"time"
)

// 手机点「停止」时发 notifications/cancelled：正在执行的命令立即结束，不用等它跑完
func TestToolCallCancelled(t *testing.T) {
	ts := newTestServer(t)
	c, _, err := dial(t, ts, "devtok")
	if err != nil {
		t.Fatal(err)
	}
	defer c.conn.Close()
	c.call("initialize", map[string]any{"protocolVersion": "2025-06-18", "clientInfo": map[string]any{"name": "test", "version": "1"}})
	c.call("p2d/setPermissions", map[string]any{"level": "full", "shell": true, "fs": true, "screen": true, "input": true})

	long := "sleep 30"
	if runtime.GOOS == "windows" {
		long = "ping -n 31 127.0.0.1 > nul"
	}
	c.id++
	callID := c.id
	start := time.Now()
	if err := c.conn.WriteJSON(map[string]any{"jsonrpc": "2.0", "id": callID, "method": "tools/call",
		"params": map[string]any{"name": "shell_exec", "arguments": map[string]any{"command": long, "timeout_sec": 60}}}); err != nil {
		t.Fatal(err)
	}
	time.Sleep(500 * time.Millisecond)
	if err := c.conn.WriteJSON(map[string]any{"jsonrpc": "2.0", "method": "notifications/cancelled",
		"params": map[string]any{"requestId": callID, "reason": "用户停止"}}); err != nil {
		t.Fatal(err)
	}
	_ = c.conn.SetReadDeadline(time.Now().Add(15 * time.Second))
	for {
		var resp map[string]any
		if err := c.conn.ReadJSON(&resp); err != nil {
			t.Fatalf("等不到结果：%v", err)
		}
		if id, ok := resp["id"].(float64); !ok || int(id) != callID {
			continue
		}
		if d := time.Since(start); d > 10*time.Second {
			t.Fatalf("取消后过了 %v 才结束", d)
		}
		res, _ := resp["result"].(map[string]any)
		text := ""
		for _, it := range res["content"].([]any) {
			text += it.(map[string]any)["text"].(string)
		}
		if !strings.Contains(text, "已取消") {
			t.Fatalf("结果应说明已取消：%s", text)
		}
		return
	}
}
