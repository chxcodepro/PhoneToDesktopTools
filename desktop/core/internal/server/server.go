// Package server 提供 MCP over WebSocket 服务和本机状态接口。
package server

import (
	"encoding/json"
	"log"
	"net"
	"net/http"
	"os"
	"runtime"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"

	"p2d/core/internal/tools"
)

// Version 由构建脚本通过 -ldflags 注入。
var Version = "dev"

// DeviceSource 提供设备状态（由 adb 管理器实现）。
type DeviceSource interface {
	Snapshot() any
	Available() bool
	SuppressAll() // 用户点「断开」后，拔线前不再自动连接
}

// Server MCP 服务。
type Server struct {
	reg     *tools.Registry
	Tokens  *TokenStore
	Devices DeviceSource

	mu       sync.Mutex
	sessions map[int64]*Session
	nextID   int64
	upgrader websocket.Upgrader
	started  time.Time
	OnChange func() // 会话变化时回调（GUI 刷新用）
}

func New(reg *tools.Registry, tokens *TokenStore) *Server {
	return &Server{
		reg:      reg,
		Tokens:   tokens,
		sessions: map[int64]*Session{},
		started:  time.Now(),
		upgrader: websocket.Upgrader{
			ReadBufferSize:  64 << 10,
			WriteBufferSize: 64 << 10,
			// 只监听 127.0.0.1 且需要令牌，手机端 RN 的 Origin 不固定，这里不校验
			CheckOrigin: func(r *http.Request) bool { return true },
		},
	}
}

// Handler 返回 HTTP 路由。
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/mcp", s.handleMCP)
	mux.HandleFunc("/api/status", s.handleStatus)
	mux.HandleFunc("/api/disconnect", s.handleDisconnect)
	return localOnly(mux)
}

func localOnly(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host, _, err := net.SplitHostPort(r.RemoteAddr)
		if err != nil || !net.ParseIP(host).IsLoopback() {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) handleMCP(w http.ResponseWriter, r *http.Request) {
	serial, ok := s.Tokens.Lookup(r.URL.Query().Get("token"))
	if !ok {
		http.Error(w, "令牌无效，请重新插拔数据线", http.StatusUnauthorized)
		return
	}
	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	id := atomic.AddInt64(&s.nextID, 1)
	sess := newSession(id, serial, conn, s.reg)

	s.mu.Lock()
	// 同一台手机重连时，关闭旧连接
	for oid, old := range s.sessions {
		if old.serial == serial {
			go old.Close("同一设备已重新连接")
			delete(s.sessions, oid)
		}
	}
	s.sessions[id] = sess
	s.mu.Unlock()
	log.Printf("[会话 %d] 手机已连接（设备 %s）", id, serial)
	s.changed()

	sess.run()

	s.mu.Lock()
	if s.sessions[id] == sess {
		delete(s.sessions, id)
	}
	s.mu.Unlock()
	_ = conn.Close()
	log.Printf("[会话 %d] 连接已断开", id)
	s.changed()
}

func (s *Server) changed() {
	if s.OnChange != nil {
		s.OnChange()
	}
}

// Sessions 当前所有会话。
func (s *Server) Sessions() []SessionInfo {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]SessionInfo, 0, len(s.sessions))
	for _, sess := range s.sessions {
		out = append(out, sess.Info())
	}
	return out
}

// HasSerial 某台手机当前是否有会话。
func (s *Server) HasSerial(serial string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, sess := range s.sessions {
		if sess.serial == serial {
			return true
		}
	}
	return false
}

// CloseSerial 断开某台设备的会话（拔线时调用）。
func (s *Server) CloseSerial(serial, reason string) {
	s.mu.Lock()
	var toClose []*Session
	for id, sess := range s.sessions {
		if sess.serial == serial {
			toClose = append(toClose, sess)
			delete(s.sessions, id)
		}
	}
	s.mu.Unlock()
	for _, sess := range toClose {
		sess.Close(reason)
	}
	if len(toClose) > 0 {
		s.changed()
	}
}

// DisconnectAll 断开所有手机，并作废令牌。
func (s *Server) DisconnectAll() {
	if s.Devices != nil {
		s.Devices.SuppressAll()
	}
	s.Tokens.RevokeAll()
	s.mu.Lock()
	all := s.sessions
	s.sessions = map[int64]*Session{}
	s.mu.Unlock()
	for _, sess := range all {
		sess.Close("电脑端已断开连接")
	}
	log.Printf("已断开所有手机")
	s.changed()
}

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	host, _ := os.Hostname()
	st := map[string]any{
		"version":  Version,
		"hostname": host,
		"os":       runtime.GOOS,
		"arch":     runtime.GOARCH,
		"uptime":   int(time.Since(s.started).Seconds()),
		"sessions": s.Sessions(),
	}
	if s.Devices != nil {
		st["adbAvailable"] = s.Devices.Available()
		st["devices"] = s.Devices.Snapshot()
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(st)
}

func (s *Server) handleDisconnect(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	s.DisconnectAll()
	w.WriteHeader(http.StatusNoContent)
}
