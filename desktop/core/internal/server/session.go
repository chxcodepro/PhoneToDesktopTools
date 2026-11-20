package server

import (
	"context"
	"encoding/json"
	"log"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"p2d/core/internal/perm"
	"p2d/core/internal/tools"
)

// 支持的 MCP 协议版本，第一个为首选。
var supportedVersions = []string{"2025-06-18", "2025-03-26", "2024-11-05"}

const (
	errParse          = -32700
	errInvalidRequest = -32600
	errMethodNotFound = -32601
	errInvalidParams  = -32602
	errInternal       = -32603

	pingInterval = 15 * time.Second
	readTimeout  = 45 * time.Second
	writeTimeout = 20 * time.Second
)

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type rpcMessage struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

// SessionInfo 用于状态接口展示。
type SessionInfo struct {
	ID          int64            `json:"id"`
	Serial      string           `json:"serial"`
	Client      string           `json:"client"`
	ConnectedAt time.Time        `json:"connectedAt"`
	Permissions perm.Permissions `json:"permissions"`
}

// Session 一条手机连接。
type Session struct {
	id     int64
	serial string
	conn   *websocket.Conn
	reg    *tools.Registry

	writeMu sync.Mutex
	mu      sync.Mutex
	perms   perm.Permissions
	client  string
	since   time.Time

	ctx    context.Context
	cancel context.CancelFunc
}

func newSession(id int64, serial string, conn *websocket.Conn, reg *tools.Registry) *Session {
	ctx, cancel := context.WithCancel(context.Background())
	return &Session{id: id, serial: serial, conn: conn, reg: reg, perms: perm.Default(), since: time.Now(), ctx: ctx, cancel: cancel}
}

func (s *Session) Info() SessionInfo {
	s.mu.Lock()
	defer s.mu.Unlock()
	return SessionInfo{ID: s.id, Serial: s.serial, Client: s.client, ConnectedAt: s.since, Permissions: s.perms}
}

// Close 主动断开。
func (s *Session) Close(reason string) {
	s.writeMu.Lock()
	_ = s.conn.WriteControl(websocket.CloseMessage,
		websocket.FormatCloseMessage(websocket.CloseNormalClosure, reason), time.Now().Add(time.Second))
	s.writeMu.Unlock()
	s.cancel()
	_ = s.conn.Close()
}

func (s *Session) send(m rpcMessage) {
	m.JSONRPC = "2.0"
	b, err := json.Marshal(m)
	if err != nil {
		log.Printf("[会话 %d] 序列化响应失败：%v", s.id, err)
		return
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	_ = s.conn.SetWriteDeadline(time.Now().Add(writeTimeout))
	if err := s.conn.WriteMessage(websocket.TextMessage, b); err != nil {
		s.cancel()
	}
}

func (s *Session) reply(id json.RawMessage, result any) {
	if result == nil {
		result = struct{}{}
	}
	s.send(rpcMessage{ID: id, Result: result})
}

func (s *Session) fail(id json.RawMessage, code int, msg string) {
	if len(id) == 0 {
		id = json.RawMessage("null")
	}
	s.send(rpcMessage{ID: id, Error: &rpcError{Code: code, Message: msg}})
}

// run 读取消息直到连接断开。
func (s *Session) run() {
	defer s.cancel()
	s.conn.SetReadLimit(64 << 20)
	_ = s.conn.SetReadDeadline(time.Now().Add(readTimeout))
	s.conn.SetPongHandler(func(string) error {
		return s.conn.SetReadDeadline(time.Now().Add(readTimeout))
	})

	go func() {
		t := time.NewTicker(pingInterval)
		defer t.Stop()
		for {
			select {
			case <-s.ctx.Done():
				return
			case <-t.C:
				s.writeMu.Lock()
				err := s.conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(writeTimeout))
				s.writeMu.Unlock()
				if err != nil {
					s.cancel()
					_ = s.conn.Close()
					return
				}
			}
		}
	}()

	for {
		typ, data, err := s.conn.ReadMessage()
		if err != nil {
			return
		}
		_ = s.conn.SetReadDeadline(time.Now().Add(readTimeout))
		if typ != websocket.TextMessage {
			continue
		}
		var m rpcMessage
		if err := json.Unmarshal(data, &m); err != nil {
			s.fail(nil, errParse, "JSON 解析失败")
			continue
		}
		if m.Method == "" {
			continue // 客户端对服务端请求的响应，目前没有用到
		}
		s.dispatch(m)
	}
}

func isNotification(m rpcMessage) bool {
	return len(m.ID) == 0 || string(m.ID) == "null"
}

func (s *Session) dispatch(m rpcMessage) {
	notify := isNotification(m)
	switch m.Method {
	case "initialize":
		var p struct {
			ProtocolVersion string `json:"protocolVersion"`
			ClientInfo      struct {
				Name    string `json:"name"`
				Version string `json:"version"`
			} `json:"clientInfo"`
		}
		_ = json.Unmarshal(m.Params, &p)
		version := supportedVersions[0]
		for _, v := range supportedVersions {
			if v == p.ProtocolVersion {
				version = v
			}
		}
		s.mu.Lock()
		s.client = p.ClientInfo.Name + " " + p.ClientInfo.Version
		s.mu.Unlock()
		log.Printf("[会话 %d] 手机端握手：%s（协议 %s）", s.id, s.client, version)
		s.reply(m.ID, map[string]any{
			"protocolVersion": version,
			"capabilities":    map[string]any{"tools": map[string]any{"listChanged": false}},
			"serverInfo":      map[string]any{"name": "p2d-core", "version": Version},
			"instructions":    "这是用户的电脑。操作前可先调用 sys_info 了解系统；看屏幕用 screen_capture；读写文件用 fs_* 工具。",
		})
	case "notifications/initialized", "notifications/cancelled":
		// 无需处理
	case "ping":
		if !notify {
			s.reply(m.ID, nil)
		}
	case "tools/list":
		s.reply(m.ID, map[string]any{"tools": s.reg.List()})
	case "tools/call":
		var p struct {
			Name      string          `json:"name"`
			Arguments json.RawMessage `json:"arguments"`
		}
		if err := json.Unmarshal(m.Params, &p); err != nil || p.Name == "" {
			s.fail(m.ID, errInvalidParams, "tools/call 需要 name")
			return
		}
		perms := s.Info().Permissions
		go func() {
			start := time.Now()
			res, ok := s.reg.Call(s.ctx, perms, p.Name, p.Arguments)
			if !ok {
				s.fail(m.ID, errInvalidParams, "工具不存在："+p.Name)
				return
			}
			status := "成功"
			if res.IsError {
				status = "失败"
			}
			log.Printf("[会话 %d] 调用 %s %s（%.0f ms）", s.id, p.Name, status, float64(time.Since(start).Milliseconds()))
			if !notify {
				s.reply(m.ID, res)
			}
		}()
	case "p2d/setPermissions":
		var p perm.Permissions
		if err := json.Unmarshal(m.Params, &p); err != nil {
			s.fail(m.ID, errInvalidParams, "权限参数格式错误")
			return
		}
		if err := p.Validate(); err != nil {
			s.fail(m.ID, errInvalidParams, err.Error())
			return
		}
		s.mu.Lock()
		s.perms = p
		s.mu.Unlock()
		log.Printf("[会话 %d] 权限更新：%s（命令 %v，文件 %v，屏幕 %v，键鼠 %v）", s.id, p.Level, p.Shell, p.FS, p.Screen, p.Input)
		s.reply(m.ID, map[string]any{"permissions": p})
	default:
		if !notify {
			s.fail(m.ID, errMethodNotFound, "不支持的方法："+m.Method)
		}
	}
}
