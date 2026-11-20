package server

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"p2d/core/internal/tools"
)

type client struct {
	t    *testing.T
	conn *websocket.Conn
	id   int
}

func dial(t *testing.T, ts *httptest.Server, token string) (*client, *http.Response, error) {
	u := "ws" + strings.TrimPrefix(ts.URL, "http") + "/mcp?token=" + token
	conn, resp, err := websocket.DefaultDialer.Dial(u, nil)
	if err != nil {
		return nil, resp, err
	}
	return &client{t: t, conn: conn}, resp, nil
}

func (c *client) call(method string, params any) map[string]any {
	c.t.Helper()
	c.id++
	msg := map[string]any{"jsonrpc": "2.0", "id": c.id, "method": method}
	if params != nil {
		msg["params"] = params
	}
	if err := c.conn.WriteJSON(msg); err != nil {
		c.t.Fatalf("发送失败：%v", err)
	}
	_ = c.conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	for {
		var resp map[string]any
		if err := c.conn.ReadJSON(&resp); err != nil {
			c.t.Fatalf("读取失败：%v", err)
		}
		if id, ok := resp["id"].(float64); ok && int(id) == c.id {
			return resp
		}
	}
}

func (c *client) tool(name string, args any) (text string, isError bool) {
	c.t.Helper()
	resp := c.call("tools/call", map[string]any{"name": name, "arguments": args})
	res, ok := resp["result"].(map[string]any)
	if !ok {
		c.t.Fatalf("tools/call %s 没有 result：%v", name, resp)
	}
	for _, it := range res["content"].([]any) {
		m := it.(map[string]any)
		if m["type"] == "text" {
			text += m["text"].(string)
		}
	}
	isError, _ = res["isError"].(bool)
	return text, isError
}

func newTestServer(t *testing.T) *httptest.Server {
	srv := New(tools.NewRegistry(), NewTokenStore("devtok"))
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return ts
}

func TestUnauthorized(t *testing.T) {
	ts := newTestServer(t)
	_, resp, err := dial(t, ts, "wrong")
	if err == nil {
		t.Fatal("错误令牌应当被拒绝")
	}
	if resp == nil || resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("期望 401，实际 %v", resp)
	}
}

func TestHandshakeAndPermissions(t *testing.T) {
	ts := newTestServer(t)
	c, _, err := dial(t, ts, "devtok")
	if err != nil {
		t.Fatal(err)
	}
	defer c.conn.Close()

	init := c.call("initialize", map[string]any{
		"protocolVersion": "2025-06-18",
		"clientInfo":      map[string]any{"name": "test", "version": "1"},
		"capabilities":    map[string]any{},
	})
	res := init["result"].(map[string]any)
	if res["protocolVersion"] != "2025-06-18" {
		t.Fatalf("协议版本不对：%v", res)
	}
	_ = c.conn.WriteJSON(map[string]any{"jsonrpc": "2.0", "method": "notifications/initialized"})

	list := c.call("tools/list", nil)
	names := map[string]bool{}
	for _, it := range list["result"].(map[string]any)["tools"].([]any) {
		names[it.(map[string]any)["name"].(string)] = true
	}
	for _, want := range []string{"sys_info", "shell_exec", "fs_read", "fs_edit", "screen_capture", "input_mouse", "input_keyboard"} {
		if !names[want] {
			t.Errorf("缺少工具 %s", want)
		}
	}

	if r := c.call("ping", nil); r["error"] != nil {
		t.Fatalf("ping 失败：%v", r)
	}

	dir := t.TempDir()
	file := filepath.Join(dir, "a.txt")

	// 默认只读：写文件应被拒绝
	if txt, isErr := c.tool("fs_write", map[string]any{"path": file, "content": "x"}); !isErr || !strings.Contains(txt, "只读") {
		t.Fatalf("只读权限下应拒绝写入，实际：%v %s", isErr, txt)
	}

	// 标准权限：可写文件，不能执行命令
	c.call("p2d/setPermissions", map[string]any{"level": "standard", "shell": true, "fs": true, "screen": true, "input": true})
	if txt, isErr := c.tool("fs_write", map[string]any{"path": file, "content": "第一行\n第二行\n"}); isErr {
		t.Fatalf("写入失败：%s", txt)
	}
	if _, isErr := c.tool("shell_exec", map[string]any{"command": "echo hi"}); !isErr {
		t.Fatal("标准权限下应拒绝执行命令")
	}

	// 完全控制 + 关闭文件开关
	c.call("p2d/setPermissions", map[string]any{"level": "full", "shell": true, "fs": false, "screen": true, "input": true})
	if txt, isErr := c.tool("fs_read", map[string]any{"path": file}); !isErr || !strings.Contains(txt, "读写文件") {
		t.Fatalf("关闭文件开关后应拒绝读取：%s", txt)
	}
	txt, isErr := c.tool("shell_exec", map[string]any{"command": "echo 你好"})
	if isErr || !strings.Contains(txt, "你好") {
		t.Fatalf("执行命令失败：%s", txt)
	}

	// 非法权限级别
	if r := c.call("p2d/setPermissions", map[string]any{"level": "root"}); r["error"] == nil {
		t.Fatal("非法权限级别应返回错误")
	}
	// 未知方法 / 未知工具
	if r := c.call("foo/bar", nil); r["error"] == nil {
		t.Fatal("未知方法应返回错误")
	}
	if r := c.call("tools/call", map[string]any{"name": "nope"}); r["error"] == nil {
		t.Fatal("未知工具应返回错误")
	}
	_ = os.Remove(file)
}

func TestScreenStream(t *testing.T) {
	ts := newTestServer(t)
	c, _, err := dial(t, ts, "devtok")
	if err != nil {
		t.Fatal(err)
	}
	defer c.conn.Close()

	// 关闭屏幕权限时应拒绝
	c.call("p2d/setPermissions", map[string]any{"level": "full", "shell": true, "fs": true, "screen": false, "input": true})
	if r := c.call("p2d/screen.start", map[string]any{}); r["error"] == nil {
		t.Fatal("关闭屏幕权限后应拒绝推流")
	}

	c.call("p2d/setPermissions", map[string]any{"level": "readonly", "shell": true, "fs": true, "screen": true, "input": true})
	r := c.call("p2d/screen.start", map[string]any{"fps": 10, "maxWidth": 640})
	if r["error"] != nil {
		t.Skipf("当前环境无法截图：%v", r["error"])
	}
	frames, withData := 0, 0
	deadline := time.Now().Add(5 * time.Second)
	for frames < 3 && time.Now().Before(deadline) {
		_ = c.conn.SetReadDeadline(deadline)
		var m map[string]any
		if err := c.conn.ReadJSON(&m); err != nil {
			t.Fatal(err)
		}
		switch m["method"] {
		case "p2d/screen.frame":
			frames++
			p := m["params"].(map[string]any)
			if p["data"] != nil {
				withData++
			}
			if w := p["width"].(float64); w > 640 {
				t.Fatalf("宽度应不超过 640，实际 %v", w)
			}
		case "p2d/screen.error":
			t.Skipf("当前环境无法截图：%v", m["params"])
		}
	}
	if frames == 0 || withData == 0 {
		t.Fatalf("没有收到画面：frames=%d withData=%d", frames, withData)
	}
	if r := c.call("p2d/screen.stop", nil); r["error"] != nil {
		t.Fatalf("停止失败：%v", r)
	}
}
