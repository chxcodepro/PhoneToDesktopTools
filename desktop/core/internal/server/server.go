// Package server 提供 MCP over WebSocket 服务和本机状态接口。
package server

import (
	"encoding/json"
	"errors"
	"log"
	"net"
	"net/http"
	"os"
	"reflect"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"

	"p2d/core/internal/stdiomcp"
	"p2d/core/internal/tools"
)

// Version 由构建脚本通过 -ldflags 注入。
var Version = "dev"

// DeviceSource 提供设备状态（由 internal/adb 的设备管理器实现）。
type DeviceSource interface {
	Snapshot() any
	Available() bool
	Problem() string // 不能连接开了 USB 调试的手机的原因
	SuppressAll()    // 用户点「断开」后，拔线前不再自动连接
}

// AccessorySource 免调试连接（AOA 配件模式，由 internal/aoa 实现，仅 Linux）
type AccessorySource interface {
	Devices() any            // 设备列表，字段和 adb 设备相同
	Problem() string         // 读不到 USB 设备的原因
	Connect(id string) error // 用户点了「免调试连接」
	SuppressAll()            // 用户点「断开」后，拔线前不再连接
}

// IPhoneSource iPhone 数据线连接（经 usbmuxd，由 internal/iphone 实现）
type IPhoneSource interface {
	Devices() any    // 设备列表，字段和 adb 设备相同
	Problem() string // 不能经数据线连接 iPhone 的原因（如没装 usbmuxd）
	SuppressAll()    // 用户点「断开」后，拔线前不再连接
}

// BlankScreen 黑屏（由 internal/blank 实现）：手机连着时让电脑显示器黑屏，手机上照常看得到画面
type BlankScreen interface {
	Supported() error // 不支持时返回原因
	Show() error
	Hide()
}

// Server MCP 服务。
type Server struct {
	reg       *tools.Registry
	Tokens    *TokenStore
	Devices   DeviceSource
	Accessory AccessorySource // 免调试连接，不支持的系统为 nil
	IPhones   IPhoneSource    // iPhone 数据线连接，未启用时为 nil
	Blank     BlankScreen     // 黑屏，为 nil 时不支持

	blankMu   sync.Mutex
	blankWant map[int64]bool // 要求黑屏的会话
	blankOn   bool
	LAN       *LANConfig      // 局域网直连，未开启时为 nil
	Driver    *ElevatedAction // 手机 USB 驱动检测与安装（仅 Windows），不支持时为 nil
	Firewall  *ElevatedAction // 防火墙放行局域网直连端口（银河麒麟），不支持时为 nil
	// 锁屏远程支持（Windows）：状态和开启 / 关闭，不支持时为 nil
	SecureStatus func() any
	SecureOn     *ElevatedAction
	SecureOff    *ElevatedAction

	// 用户在电脑上点了「断开」：局域网的自动重连先拒绝，手机上手动点「连接」才接受
	lanSuppressed atomic.Bool

	mu       sync.Mutex
	sessions map[int64]*Session
	nextID   int64
	upgrader websocket.Upgrader
	started  time.Time
	OnChange func()                      // 会话变化时回调（GUI 刷新用）
	mcp      map[string]*stdiomcp.Client // 电脑上运行的 stdio MCP（手机序列号/ID → 进程），断线重连后继续使用
}

func New(reg *tools.Registry, tokens *TokenStore) *Server {
	return &Server{
		reg:      reg,
		Tokens:   tokens,
		sessions: map[int64]*Session{},
		mcp:      map[string]*stdiomcp.Client{},
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
	mux.HandleFunc("/api/pairing/start", s.handlePairingAPI)
	mux.HandleFunc("/api/pairing/cancel", s.handlePairingAPI)
	mux.HandleFunc("/api/paired/remove", s.handlePairingAPI)
	mux.HandleFunc("/api/driver/install", s.handleElevated(func() *ElevatedAction { return s.Driver }, "这个系统不需要安装手机驱动"))
	mux.HandleFunc("/api/firewall/allow", s.handleElevated(func() *ElevatedAction { return s.Firewall }, "这个系统不需要放行防火墙"))
	mux.HandleFunc("/api/aoa/connect", s.handleAOAConnect)
	mux.HandleFunc("/api/secure-desktop/enable", s.handleElevated(func() *ElevatedAction { return s.SecureOn }, "这个系统不支持锁屏远程支持"))
	mux.HandleFunc("/api/secure-desktop/disable", s.handleElevated(func() *ElevatedAction { return s.SecureOff }, "这个系统不支持锁屏远程支持"))
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
		log.Printf("拒绝数据线连接：令牌无效（手机端可能还在用旧令牌）")
		http.Error(w, "令牌无效，请重新插拔数据线", http.StatusUnauthorized)
		return
	}
	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("数据线连接握手失败：%v", err)
		return
	}
	id := atomic.AddInt64(&s.nextID, 1)
	sess := newSession(id, serial, conn, s.reg)
	sess.server = s
	s.lanSuppressed.Store(false) // 插线重新连接后，局域网也恢复自动重连
	log.Printf("[会话 %d] 手机已连接（设备 %s）", id, serial)
	s.runSession(sess, conn)
}

// runSession 登记会话并运行到断开（USB 和局域网共用）。
func (s *Server) runSession(sess *Session, conn *websocket.Conn) {
	id, serial := sess.id, sess.serial
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
	s.changed()

	sess.run()

	s.mu.Lock()
	if s.sessions[id] == sess {
		delete(s.sessions, id)
	}
	s.mu.Unlock()
	_ = conn.Close()
	// 手机断开后不能让电脑一直黑着：撤掉这个会话的黑屏要求
	_ = s.setBlank(id, false)
	log.Printf("[会话 %d] 连接已断开", id)
	s.changed()
}

// setBlank 记下某个会话要不要黑屏；有任何一个会话要求就黑屏，都不要求时恢复显示
func (s *Server) setBlank(id int64, on bool) error {
	s.blankMu.Lock()
	defer s.blankMu.Unlock()
	if s.Blank == nil {
		if on {
			return errors.New("这台电脑的电脑端不支持黑屏")
		}
		return nil
	}
	if on {
		if err := s.Blank.Supported(); err != nil {
			return err
		}
	}
	if s.blankWant == nil {
		s.blankWant = map[int64]bool{}
	}
	if on {
		s.blankWant[id] = true
	} else {
		delete(s.blankWant, id)
	}
	want := len(s.blankWant) > 0
	if want == s.blankOn {
		return nil
	}
	if want {
		if err := s.Blank.Show(); err != nil {
			delete(s.blankWant, id)
			return err
		}
		log.Printf("[会话 %d] 已打开黑屏", id)
	} else {
		s.Blank.Hide()
		log.Printf("已关闭黑屏，恢复显示")
	}
	s.blankOn = want
	s.changed()
	return nil
}

// blankStatus 状态接口里的黑屏信息
func (s *Server) blankStatus() map[string]any {
	st := map[string]any{"supported": false}
	if s.Blank == nil {
		return st
	}
	if err := s.Blank.Supported(); err != nil {
		st["reason"] = err.Error()
		return st
	}
	s.blankMu.Lock()
	defer s.blankMu.Unlock()
	st["supported"] = true
	st["on"] = s.blankOn
	return st
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
	// 手机断开后结束它启动的 MCP 进程（同一部手机还有别的通道在线时保留）
	s.mu.Lock()
	owners := map[string]bool{serial: true}
	for _, sess := range toClose {
		owners[sess.mcpOwner()] = true
	}
	for _, sess := range s.sessions {
		delete(owners, sess.mcpOwner())
	}
	s.mu.Unlock()
	s.stopMCP(func(key string) bool {
		for o := range owners {
			if strings.HasPrefix(key, o+"/") {
				return true
			}
		}
		return false
	})
}

// DisconnectAll 断开所有手机，并作废令牌。
func (s *Server) DisconnectAll() {
	if s.Devices != nil {
		s.Devices.SuppressAll()
	}
	if s.Accessory != nil {
		s.Accessory.SuppressAll()
	}
	if s.IPhones != nil {
		s.IPhones.SuppressAll()
	}
	s.Tokens.RevokeAll()
	s.lanSuppressed.Store(true)
	s.mu.Lock()
	all := s.sessions
	s.sessions = map[int64]*Session{}
	s.mu.Unlock()
	for _, sess := range all {
		sess.closeWith(CloseByPC, "电脑端已断开连接")
	}
	s.StopAllMCP()
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
		"lan":      s.lanStatus(),
		"blank":    s.blankStatus(),
	}
	devices := []any{}
	if s.Devices != nil {
		st["adbAvailable"] = s.Devices.Available()
		if p := s.Devices.Problem(); p != "" {
			st["adbError"] = p
		}
		devices = appendItems(devices, s.Devices.Snapshot())
	}
	if s.Accessory != nil {
		aoa := map[string]any{"enabled": true}
		if p := s.Accessory.Problem(); p != "" {
			aoa["problem"] = p
		}
		st["aoa"] = aoa
		devices = appendItems(devices, s.Accessory.Devices())
	}
	if s.IPhones != nil {
		ip := map[string]any{"enabled": true}
		if p := s.IPhones.Problem(); p != "" {
			ip["problem"] = p
		}
		st["iphone"] = ip
		devices = appendItems(devices, s.IPhones.Devices())
	}
	if s.Devices != nil || s.Accessory != nil || s.IPhones != nil {
		st["devices"] = devices
	}
	if m := s.Driver.pending(); m != nil {
		st["driverMissing"] = m
	}
	if b := s.Firewall.pending(); b != nil {
		st["lanBlocked"] = b
	}
	if s.SecureStatus != nil {
		if v := s.SecureStatus(); v != nil {
			st["secureDesktop"] = v
		}
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

// appendItems 把任意切片的元素追加到 out（adb 和免调试连接的设备类型不同，状态接口里合成一个列表）
func appendItems(out []any, list any) []any {
	v := reflect.ValueOf(list)
	if v.Kind() != reflect.Slice {
		return out
	}
	for i := 0; i < v.Len(); i++ {
		out = append(out, v.Index(i).Interface())
	}
	return out
}

// handleAOAConnect 电脑端界面上点了「免调试连接」：让这台手机切换到配件模式
func (s *Server) handleAOAConnect(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	res := map[string]any{"ok": true}
	if s.Accessory == nil {
		res = map[string]any{"ok": false, "message": "这个系统不支持免调试连接，请在手机上开启 USB 调试"}
	} else if err := s.Accessory.Connect(r.URL.Query().Get("id")); err != nil {
		res = map[string]any{"ok": false, "message": err.Error()}
	} else {
		s.lanSuppressed.Store(false)
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(res)
}
