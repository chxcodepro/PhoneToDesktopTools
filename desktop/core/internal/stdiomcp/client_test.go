package stdiomcp

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"
)

// 测试二进制自己扮演一个 stdio MCP 服务
func TestMain(m *testing.M) {
	if os.Getenv("P2D_FAKE_MCP") == "1" {
		fakeServer()
		return
	}
	os.Exit(m.Run())
}

func fakeServer() {
	in := bufio.NewScanner(os.Stdin)
	fmt.Println("这是一行日志，不是 JSON") // 有的服务会往 stdout 打日志
	for in.Scan() {
		var m struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
			Params struct {
				Name      string         `json:"name"`
				Arguments map[string]any `json:"arguments"`
				Cursor    string         `json:"cursor"`
			} `json:"params"`
		}
		if json.Unmarshal(in.Bytes(), &m) != nil || len(m.ID) == 0 {
			continue
		}
		var result any
		switch m.Method {
		case "initialize":
			result = map[string]any{"protocolVersion": "2025-06-18", "serverInfo": map[string]any{"name": "fake"}, "capabilities": map[string]any{}}
		case "tools/list":
			if m.Params.Cursor == "" {
				result = map[string]any{"tools": []any{map[string]any{"name": "echo"}}, "nextCursor": "p2"}
			} else {
				result = map[string]any{"tools": []any{map[string]any{"name": "env"}}}
			}
		case "tools/call":
			text := fmt.Sprint(m.Params.Arguments["text"])
			if m.Params.Name == "env" {
				text = os.Getenv("FAKE_TOKEN")
			}
			result = map[string]any{"content": []any{map[string]any{"type": "text", "text": text}}}
		default:
			b, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": m.ID, "error": map[string]any{"code": -32601, "message": "nope"}})
			fmt.Println(string(b))
			continue
		}
		b, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": m.ID, "result": result})
		fmt.Println(string(b))
	}
}

func TestStdioMCP(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	os.Setenv("P2D_FAKE_MCP", "1")
	defer os.Unsetenv("P2D_FAKE_MCP")
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	c, err := Start(ctx, Config{Command: exe, Env: map[string]string{"FAKE_TOKEN": "abc123"}})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if c.Name != "fake" || len(c.Tools) != 2 {
		t.Fatalf("握手或分页取工具失败：name=%q tools=%d", c.Name, len(c.Tools))
	}
	res, err := c.Request(ctx, "tools/call", map[string]any{"name": "echo", "arguments": map[string]any{"text": "你好"}})
	if err != nil || !strings.Contains(string(res), "你好") {
		t.Fatalf("调用失败：%v %s", err, res)
	}
	res, err = c.Request(ctx, "tools/call", map[string]any{"name": "env", "arguments": map[string]any{}})
	if err != nil || !strings.Contains(string(res), "abc123") {
		t.Fatalf("环境变量没有传给进程：%v %s", err, res)
	}
	if _, err := c.Request(ctx, "resources/list", nil); err == nil || !strings.Contains(err.Error(), "nope") {
		t.Fatalf("应返回 MCP 错误：%v", err)
	}
	c.Close()
	time.Sleep(200 * time.Millisecond)
	if c.Alive() {
		t.Fatal("Close 后进程应退出")
	}
	if _, err := c.Request(ctx, "tools/list", nil); err == nil {
		t.Fatal("进程退出后请求应报错")
	}
}

func TestStartMissingCommand(t *testing.T) {
	_, err := Start(context.Background(), Config{Command: "p2d-no-such-command-xyz"})
	if err == nil || !strings.Contains(err.Error(), "找不到命令") {
		t.Fatalf("got %v", err)
	}
}
