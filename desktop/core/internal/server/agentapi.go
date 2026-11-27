package server

// 电脑端界面里的 AI 助手（Electron 页面里运行 Agent）调用本机工具的接口：
//
//	GET  /api/agent/tools                     → { tools, host, os, downloadDir }
//	POST /api/agent/call   { name, arguments } → 工具结果（和 MCP tools/call 相同）
//	POST /api/agent/verify { path }           → { signature }（Windows 数字签名，下载的安装包用）
//	POST /api/agent/mcp/start { id, command, args, env, cwd } → { name, tools }（电脑上的 stdio MCP）
//	POST /api/agent/mcp/call  { id, name, arguments }          → MCP tools/call 的结果
//	POST /api/agent/mcp/stop  { id }
//
// 这些接口能执行命令，只靠「只允许本机访问」不够：浏览器里的网页可以向 127.0.0.1 发请求，
// 同一台电脑上的其他用户（远程桌面服务器）也能连本机端口。所以要带令牌（请求头 X-P2D-Agent）：
// 启动时随机生成，写进数据目录的 agent-token-<端口> 文件（只有当前用户能读），电脑端界面读文件取得
// （带端口：调试时另开的电脑端不会覆盖正在用的那个的令牌）。
// 自定义请求头还会让浏览器先发跨域预检，这里不回跨域许可，网页就发不出来。

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"time"

	"p2d/core/internal/perm"
	"p2d/core/internal/stdiomcp"
)

// EnableAgent 生成令牌并写进 dir/agent-token-<port>。要在监听端口成功之后调用：
// 端口被已经在运行的电脑端占着时，不能把那个电脑端的令牌覆盖掉。
func (s *Server) EnableAgent(dir string, port int) error {
	if dir == "" {
		return os.ErrNotExist
	}
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		return err
	}
	tok := hex.EncodeToString(b)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	p := filepath.Join(dir, fmt.Sprintf("agent-token-%d", port))
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, []byte(tok), 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, p); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	s.agentToken.Store(tok)
	return nil
}

func (s *Server) agentAuth(w http.ResponseWriter, r *http.Request) bool {
	want, _ := s.agentToken.Load().(string)
	got := r.Header.Get("X-P2D-Agent")
	if want == "" || subtle.ConstantTimeCompare([]byte(got), []byte(want)) != 1 {
		http.Error(w, "令牌无效", http.StatusUnauthorized)
		return false
	}
	return true
}

// agentPerms 用户坐在电脑前自己用，不再分权限（提权仍会弹 UAC / 密码框）
var agentPerms = perm.Permissions{Level: perm.Full, Shell: true, FS: true, Screen: true, Input: true}

func (s *Server) handleAgentTools(w http.ResponseWriter, r *http.Request) {
	if !s.agentAuth(w, r) {
		return
	}
	host, _ := os.Hostname()
	replyJSON(w, map[string]any{
		"tools":       s.reg.List(),
		"host":        host,
		"os":          runtime.GOOS,
		"downloadDir": UploadDir(),
	})
}

func (s *Server) handleAgentCall(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "需要 POST", http.StatusMethodNotAllowed)
		return
	}
	if !s.agentAuth(w, r) {
		return
	}
	var p struct {
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 16<<20)).Decode(&p); err != nil || p.Name == "" {
		http.Error(w, "需要 name", http.StatusBadRequest)
		return
	}
	// 界面上点「停止」时请求被取消，r.Context() 跟着取消，正在执行的命令也会结束
	start := time.Now()
	res, ok := s.reg.Call(r.Context(), agentPerms, p.Name, p.Arguments)
	if !ok {
		http.Error(w, "工具不存在："+p.Name, http.StatusNotFound)
		return
	}
	log.Printf("[电脑端助手] %s", callLine(p.Name, p.Arguments, res, float64(time.Since(start).Milliseconds())))
	replyJSON(w, res)
}

func (s *Server) handleAgentVerify(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "需要 POST", http.StatusMethodNotAllowed)
		return
	}
	if !s.agentAuth(w, r) {
		return
	}
	var p struct {
		Path string `json:"path"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&p); err != nil || p.Path == "" {
		http.Error(w, "需要 path", http.StatusBadRequest)
		return
	}
	replyJSON(w, map[string]any{"signature": fileSignature(p.Path)})
}

func replyJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(v)
}

// errNotStarted 进程不在了（电脑端服务重启过等），界面收到后重新启动再调用
var errNotStarted = errors.New("MCP 未启动（not_started）")

// agentMCPOwner 电脑端助手启动的 MCP 进程的归属（和手机会话的分开）
const agentMCPOwner = "desktop-agent"

func (s *Server) handleAgentMCP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "需要 POST", http.StatusMethodNotAllowed)
		return
	}
	if !s.agentAuth(w, r) {
		return
	}
	var p struct {
		ID        string          `json:"id"`
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
		stdiomcp.Config
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 4<<20)).Decode(&p); err != nil || p.ID == "" {
		http.Error(w, "需要 id", http.StatusBadRequest)
		return
	}
	key := s.mcpKey(agentMCPOwner, p.ID)
	fail := func(err error) { http.Error(w, err.Error(), http.StatusBadGateway) }
	switch r.URL.Path {
	case "/api/agent/mcp/start":
		if p.Command == "" {
			http.Error(w, "需要 command", http.StatusBadRequest)
			return
		}
		s.mu.Lock()
		old := s.mcp[key]
		s.mu.Unlock()
		if old != nil && old.Alive() && old.Config().Key() == p.Config.Key() {
			replyJSON(w, map[string]any{"name": old.Name, "tools": old.Tools})
			return
		}
		if old != nil {
			old.Close()
		}
		// 进程跟着电脑端服务走，不跟着这次请求结束
		c, err := stdiomcp.Start(context.Background(), p.Config)
		if err != nil {
			fail(err)
			return
		}
		s.mu.Lock()
		if prev := s.mcp[key]; prev != nil && prev != c {
			go prev.Close()
		}
		s.mcp[key] = c
		s.mu.Unlock()
		log.Printf("[电脑端助手] 已启动 MCP「%s」（%s，%d 个工具）", p.ID, p.Command, len(c.Tools))
		replyJSON(w, map[string]any{"name": c.Name, "tools": c.Tools})
	case "/api/agent/mcp/call":
		s.mu.Lock()
		c := s.mcp[key]
		s.mu.Unlock()
		if c == nil || !c.Alive() {
			fail(errNotStarted)
			return
		}
		args := p.Arguments
		if len(args) == 0 {
			args = json.RawMessage("{}")
		}
		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Minute)
		defer cancel()
		res, err := c.Request(ctx, "tools/call", map[string]any{"name": p.Name, "arguments": args})
		if err != nil {
			fail(err)
			return
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_, _ = w.Write(res)
	case "/api/agent/mcp/stop":
		s.stopMCP(func(k string) bool { return k == key })
		replyJSON(w, map[string]any{})
	default:
		http.NotFound(w, r)
	}
}
