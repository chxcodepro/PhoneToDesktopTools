// Package stdiomcp 在电脑上启动 stdio 方式的 MCP 服务（如 npx / uvx / 单文件程序），供手机端经 adb 隧道调用。
// 消息格式为按行分隔的 JSON-RPC（MCP stdio 传输）。
package stdiomcp

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"p2d/core/internal/procutil"
)

// Config 启动参数。
type Config struct {
	Command string            `json:"command"`
	Args    []string          `json:"args"`
	Env     map[string]string `json:"env"`
	Cwd     string            `json:"cwd"`
}

// Key 配置的指纹：配置不变时复用已启动的进程。
func (c Config) Key() string {
	b, _ := json.Marshal(c)
	return string(b)
}

type response struct {
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

// Client 一个 stdio MCP 进程。
type Client struct {
	cfg    Config
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	nextID atomic.Int64

	mu      sync.Mutex
	pending map[int64]chan response
	writeMu sync.Mutex
	stderr  tail
	done    chan struct{}
	exitErr error

	Name  string            // serverInfo.name
	Tools []json.RawMessage // tools/list 的结果（原样转给手机）
}

// tail 只保留最后一段 stderr，用于出错时提示。
type tail struct {
	mu  sync.Mutex
	buf []byte
}

func (t *tail) Write(p []byte) (int, error) {
	t.mu.Lock()
	t.buf = append(t.buf, p...)
	if len(t.buf) > 4096 {
		t.buf = t.buf[len(t.buf)-4096:]
	}
	t.mu.Unlock()
	return len(p), nil
}

func (t *tail) String() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return strings.TrimSpace(string(t.buf))
}

// Start 启动进程、握手并获取工具列表。
func Start(ctx context.Context, cfg Config) (*Client, error) {
	if strings.TrimSpace(cfg.Command) == "" {
		return nil, errors.New("缺少 command")
	}
	path, err := exec.LookPath(cfg.Command)
	if err != nil {
		return nil, fmt.Errorf("电脑上找不到命令 %s（需要先安装对应的运行环境，如 Node.js / Python / uv）", cfg.Command)
	}
	cmd := exec.Command(path, cfg.Args...)
	cmd.Dir = cfg.Cwd
	cmd.Env = os.Environ()
	for k, v := range cfg.Env {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
	procutil.Prepare(cmd)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	c := &Client{cfg: cfg, cmd: cmd, stdin: stdin, pending: map[int64]chan response{}, done: make(chan struct{})}
	cmd.Stderr = &c.stderr
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("启动 %s 失败：%v", cfg.Command, err)
	}
	go c.readLoop(stdout)
	go func() {
		c.exitErr = cmd.Wait()
		close(c.done)
		c.mu.Lock()
		for id, ch := range c.pending {
			close(ch)
			delete(c.pending, id)
		}
		c.mu.Unlock()
	}()

	initCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	raw, err := c.Request(initCtx, "initialize", map[string]any{
		"protocolVersion": "2025-06-18",
		"capabilities":    map[string]any{},
		"clientInfo":      map[string]any{"name": "p2d-core", "version": "0.1.0"},
	})
	if err != nil {
		c.Close()
		return nil, err
	}
	var init struct {
		ServerInfo struct {
			Name string `json:"name"`
		} `json:"serverInfo"`
	}
	_ = json.Unmarshal(raw, &init)
	c.Name = init.ServerInfo.Name
	if err := c.send(map[string]any{"jsonrpc": "2.0", "method": "notifications/initialized"}); err != nil {
		c.Close()
		return nil, err
	}
	var cursor string
	for page := 0; page < 20; page++ {
		params := map[string]any{}
		if cursor != "" {
			params["cursor"] = cursor
		}
		raw, err := c.Request(initCtx, "tools/list", params)
		if err != nil {
			c.Close()
			return nil, err
		}
		var r struct {
			Tools      []json.RawMessage `json:"tools"`
			NextCursor string            `json:"nextCursor"`
		}
		if err := json.Unmarshal(raw, &r); err != nil {
			c.Close()
			return nil, fmt.Errorf("tools/list 结果格式错误：%v", err)
		}
		c.Tools = append(c.Tools, r.Tools...)
		if r.NextCursor == "" {
			break
		}
		cursor = r.NextCursor
	}
	return c, nil
}

// Alive 进程是否还在运行。
func (c *Client) Alive() bool {
	select {
	case <-c.done:
		return false
	default:
		return true
	}
}

// Config 启动时的配置。
func (c *Client) Config() Config { return c.cfg }

func (c *Client) send(msg any) error {
	b, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	_, err = c.stdin.Write(append(b, '\n'))
	return err
}

func (c *Client) readLoop(r io.Reader) {
	br := bufio.NewReaderSize(r, 1<<20)
	for {
		line, err := br.ReadBytes('\n')
		if len(bytes.TrimSpace(line)) > 0 {
			c.handle(line)
		}
		if err != nil {
			return
		}
	}
}

func (c *Client) handle(line []byte) {
	var m struct {
		ID     json.RawMessage `json:"id"`
		Method string          `json:"method"`
		response
	}
	if err := json.Unmarshal(line, &m); err != nil {
		return // 有的服务会往 stdout 打日志，忽略
	}
	if m.Method != "" {
		// 服务端发来的请求：只支持 ping，其他回复不支持
		if len(m.ID) == 0 || string(m.ID) == "null" {
			return
		}
		if m.Method == "ping" {
			_ = c.send(map[string]any{"jsonrpc": "2.0", "id": m.ID, "result": map[string]any{}})
		} else {
			_ = c.send(map[string]any{"jsonrpc": "2.0", "id": m.ID, "error": map[string]any{"code": -32601, "message": "not supported"}})
		}
		return
	}
	var id int64
	if err := json.Unmarshal(m.ID, &id); err != nil {
		return
	}
	c.mu.Lock()
	ch, ok := c.pending[id]
	delete(c.pending, id)
	c.mu.Unlock()
	if ok {
		ch <- m.response
	}
}

// Request 发送请求并等待结果。
func (c *Client) Request(ctx context.Context, method string, params any) (json.RawMessage, error) {
	id := c.nextID.Add(1)
	ch := make(chan response, 1)
	c.mu.Lock()
	if !c.Alive() {
		c.mu.Unlock()
		return nil, c.exitError()
	}
	c.pending[id] = ch
	c.mu.Unlock()
	if err := c.send(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params}); err != nil {
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return nil, c.exitError()
	}
	select {
	case r, ok := <-ch:
		if !ok {
			return nil, c.exitError()
		}
		if r.Error != nil {
			return nil, fmt.Errorf("MCP 错误 %d：%s", r.Error.Code, r.Error.Message)
		}
		return r.Result, nil
	case <-ctx.Done():
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		_ = c.send(map[string]any{"jsonrpc": "2.0", "method": "notifications/cancelled", "params": map[string]any{"requestId": id}})
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return nil, fmt.Errorf("%s 超时", method)
		}
		return nil, ctx.Err()
	}
}

func (c *Client) exitError() error {
	msg := "MCP 进程已退出"
	if c.exitErr != nil {
		msg += "（" + c.exitErr.Error() + "）"
	}
	if s := c.stderr.String(); s != "" {
		msg += "：" + s
	}
	return errors.New(msg)
}

// Close 结束进程（含子进程，如 npx 启动的 node）。
func (c *Client) Close() {
	_ = c.stdin.Close()
	select {
	case <-c.done:
		return
	case <-time.After(500 * time.Millisecond):
	}
	procutil.KillTree(c.cmd)
}
