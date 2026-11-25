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
	Route       string           `json:"route"`          // usb / wifi
	Name        string           `json:"name,omitempty"` // 手机名（局域网直连时来自配对记录）
	Client      string           `json:"client"`
	ConnectedAt time.Time        `json:"connectedAt"`
	Permissions perm.Permissions `json:"permissions"`
}

// wsConn 会话使用的 WebSocket 连接；局域网直连时是加密包装（见 lan.go）。
type wsConn interface {
	ReadMessage() (int, []byte, error)
	WriteMessage(messageType int, data []byte) error
	WriteControl(messageType int, data []byte, deadline time.Time) error
	SetReadLimit(limit int64)
	SetReadDeadline(t time.Time) error
	SetWriteDeadline(t time.Time) error
	SetPongHandler(h func(appData string) error)
	Close() error
}

// Session 一条手机连接。
type Session struct {
	id     int64
	serial string
	route  string // usb / wifi
	owner  string // 手机端的设备 ID（握手时告知 / 配对记录），用来在换通道后继续使用同一批 MCP 进程
	name   string
	conn   wsConn
	reg    *tools.Registry
	server *Server

	writeMu sync.Mutex
	mu      sync.Mutex
	perms   perm.Permissions
	client  string
	since   time.Time

	ctx     context.Context
	cancel  context.CancelFunc
	calls   map[string]context.CancelFunc // 进行中的 tools/call（请求 ID → 取消），手机点「停止」时取消
	stream  streamState
	uploads uploadState
}

func newSession(id int64, serial string, conn wsConn, reg *tools.Registry) *Session {
	ctx, cancel := context.WithCancel(context.Background())
	return &Session{id: id, serial: serial, route: "usb", conn: conn, reg: reg, perms: perm.Default(), since: time.Now(), ctx: ctx, cancel: cancel}
}

func (s *Session) Info() SessionInfo {
	s.mu.Lock()
	defer s.mu.Unlock()
	return SessionInfo{ID: s.id, Serial: s.serial, Route: s.route, Name: s.name, Client: s.client, ConnectedAt: s.since, Permissions: s.perms}
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
	defer s.uploadDropAll()
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
				Name     string `json:"name"`
				Version  string `json:"version"`
				DeviceID string `json:"deviceId"` // 自定义扩展：手机端的设备 ID
				Device   string `json:"device"`   // 手机名
			} `json:"clientInfo"`
		}
		_ = json.Unmarshal(m.Params, &p)
		s.mu.Lock()
		if s.owner == "" && p.ClientInfo.DeviceID != "" {
			s.owner = p.ClientInfo.DeviceID
		}
		if s.name == "" && p.ClientInfo.Device != "" {
			s.name = p.ClientInfo.Device
		}
		s.mu.Unlock()
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
	case "notifications/initialized":
		// 无需处理
	case "notifications/cancelled":
		// 手机上点了「停止」：结束对应的工具调用（命令会连同子进程一起结束）
		var p struct {
			RequestID json.RawMessage `json:"requestId"`
		}
		_ = json.Unmarshal(m.Params, &p)
		s.mu.Lock()
		cancel := s.calls[string(p.RequestID)]
		s.mu.Unlock()
		if cancel != nil {
			log.Printf("[会话 %d] 手机端取消了请求 %s", s.id, p.RequestID)
			cancel()
		}
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
		ctx, cancel := context.WithCancel(s.ctx)
		key := string(m.ID)
		if !notify {
			s.mu.Lock()
			if s.calls == nil {
				s.calls = map[string]context.CancelFunc{}
			}
			s.calls[key] = cancel
			s.mu.Unlock()
		}
		go func() {
			defer func() {
				cancel()
				if !notify {
					s.mu.Lock()
					delete(s.calls, key)
					s.mu.Unlock()
				}
			}()
			start := time.Now()
			res, ok := s.reg.Call(ctx, perms, p.Name, p.Arguments)
			if !ok {
				s.fail(m.ID, errInvalidParams, "工具不存在："+p.Name)
				return
			}
			log.Printf("[会话 %d] %s", s.id, callLine(p.Name, p.Arguments, res, float64(time.Since(start).Milliseconds())))
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
	case "p2d/screen.start":
		var cfg streamConfig
		if len(m.Params) > 0 {
			if err := json.Unmarshal(m.Params, &cfg); err != nil {
				s.fail(m.ID, errInvalidParams, "推流参数格式错误")
				return
			}
		}
		if ok, why := s.Info().Permissions.Allow(perm.CatScreen, perm.Read); !ok {
			s.fail(m.ID, errInvalidRequest, why)
			return
		}
		displays, err := s.startStream(cfg)
		if err != nil {
			s.fail(m.ID, errInternal, err.Error())
			return
		}
		s.reply(m.ID, map[string]any{"displays": displays})
	case "p2d/file.read":
		// 读磁盘放到协程里，不阻塞心跳等其他消息
		go func() {
			res, err := s.fileRead(m.Params)
			if err != nil {
				s.fail(m.ID, errInvalidRequest, err.Error())
				return
			}
			if !notify {
				s.reply(m.ID, res)
			}
		}()
	case "p2d/upload.begin", "p2d/upload.chunk", "p2d/upload.end", "p2d/upload.cancel":
		handlers := map[string]func(json.RawMessage) (any, error){
			"p2d/upload.begin":  s.uploadBegin,
			"p2d/upload.chunk":  s.uploadChunk,
			"p2d/upload.end":    s.uploadEnd,
			"p2d/upload.cancel": s.uploadCancel,
		}
		res, err := handlers[m.Method](m.Params)
		if err != nil {
			s.fail(m.ID, errInvalidRequest, err.Error())
			return
		}
		if m.Method == "p2d/upload.end" {
			log.Printf("[会话 %d] 收到手机上传的文件：%v", s.id, res.(map[string]any)["path"])
		}
		if !notify {
			s.reply(m.ID, res)
		}
	case "p2d/pair.issue", "p2d/pc.info", "p2d/pair.remove":
		res, err := s.pairMethod(m.Method, m.Params)
		if err != nil {
			s.fail(m.ID, errInvalidRequest, err.Error())
			return
		}
		if !notify {
			s.reply(m.ID, res)
		}
	case "p2d/skill.has", "p2d/skill.sync", "p2d/mcp.start", "p2d/mcp.stop":
		handlers := map[string]func(json.RawMessage) (any, error){
			"p2d/skill.has":  s.skillHas,
			"p2d/skill.sync": s.skillSync,
			"p2d/mcp.start":  s.mcpStart,
			"p2d/mcp.stop":   s.mcpStop,
		}
		// 启动 MCP 可能要等较久（npx 首次运行等），放到协程里，不阻塞其他消息
		go func() {
			res, err := handlers[m.Method](m.Params)
			if err != nil {
				s.fail(m.ID, errInvalidRequest, err.Error())
				return
			}
			if !notify {
				s.reply(m.ID, res)
			}
		}()
	case "p2d/mcp.call":
		go func() {
			res, err := s.mcpCall(s.ctx, m.Params)
			if err != nil {
				s.fail(m.ID, errInvalidRequest, err.Error())
				return
			}
			if !notify {
				s.reply(m.ID, res)
			}
		}()
	case "p2d/screen.stop":
		s.stopStream()
		if !notify {
			s.reply(m.ID, nil)
		}
	default:
		if !notify {
			s.fail(m.ID, errMethodNotFound, "不支持的方法："+m.Method)
		}
	}
}
