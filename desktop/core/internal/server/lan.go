package server

// 局域网直连（docs/PROTOCOL.md 第 9 节）：
//   - /p2d/pair：配对（扫码 / 配对码），只在电脑上打开了「配对新手机」时接受；
//   - /p2d/secure：配对过的手机直接连接，握手后所有消息加密，之后和 USB 的 /mcp 会话完全一样；
//   - 插数据线（adb，可信通道）时，手机通过 p2d/pair.issue 直接拿到配对密钥。
// 局域网端口只提供这两个入口，状态接口等仍只接受本机访问。

import (
	"crypto/ecdh"
	"crypto/hmac"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"runtime"
	"strings"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"

	"p2d/core/internal/lan"
	"p2d/core/internal/sysinfo"
)

// PairingDuration 「配对新手机」窗口打开多久
const PairingDuration = 3 * time.Minute

// LANConfig 局域网直连配置。
type LANConfig struct {
	Store   *lan.Store
	Pairing *lan.PairingWindow
	Port    int // 局域网端口；0 表示未开启
}

func (s *Server) pcName() string {
	h, _ := os.Hostname()
	return h
}

// pcInfo 告诉手机的电脑信息（地址列表用于之后的 WiFi 直连）。
func (s *Server) pcInfo() map[string]any {
	info := map[string]any{"pc": s.LAN.Store.PCID(), "name": s.pcName(), "os": runtime.GOOS, "osName": sysinfo.OSName(), "port": s.LAN.Port, "addrs": lan.Addrs()}
	s.addMachineID(info)
	return info
}

// addMachineID 附上机器指纹 mid（新增字段，旧版手机端会忽略）：手机端据此合并同一台电脑的重复记录。
func (s *Server) addMachineID(m map[string]any) {
	if mid := s.LAN.Store.MachineID(); mid != "" {
		m["mid"] = mid
	}
}

// pairMethod 经 USB（本机）会话调用的配对相关方法。
func (s *Session) pairMethod(method string, raw json.RawMessage) (any, error) {
	srv := s.server
	if srv.LAN == nil || srv.LAN.Store == nil {
		return nil, errors.New("电脑端未开启局域网直连")
	}
	var p struct {
		Phone string `json:"phone"`
		Name  string `json:"name"`
	}
	_ = json.Unmarshal(raw, &p)
	switch method {
	case "p2d/pc.info":
		info := srv.pcInfo()
		if p.Phone != "" {
			_, _, paired := srv.LAN.Store.Key(p.Phone)
			info["paired"] = paired
		}
		return info, nil
	case "p2d/pair.issue":
		// 只允许经数据线（adb 隧道，令牌校验过）的会话直接发放密钥
		if s.route != "usb" {
			return nil, errors.New("只能在数据线连接时直接配对")
		}
		if p.Phone == "" {
			return nil, errors.New("需要 phone")
		}
		key := lan.Random(rand.Reader, 32)
		name := strings.TrimSpace(p.Name)
		if name == "" {
			name = "手机"
		}
		srv.LAN.Store.Add(p.Phone, name, key)
		log.Printf("[会话 %d] 已通过数据线与「%s」配对，之后可以在同一局域网内直接连接", s.id, name)
		info := srv.pcInfo()
		info["key"] = base64.StdEncoding.EncodeToString(key)
		srv.changed()
		return info, nil
	case "p2d/pair.remove":
		id := p.Phone
		if id == "" {
			id = s.mcpOwner()
		}
		srv.LAN.Store.Remove(id)
		srv.changed()
		return map[string]any{}, nil
	}
	return nil, fmt.Errorf("不支持的方法：%s", method)
}

// LANHandler 局域网端口的路由。
func (s *Server) LANHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/p2d/pair", s.handlePair)
	mux.HandleFunc("/p2d/secure", s.handleSecure)
	mux.HandleFunc("/p2d/ping", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"app": "p2d", "pc": s.LAN.Store.PCID(), "name": s.pcName(), "os": runtime.GOOS, "osName": sysinfo.OSName()})
	})
	return mux
}

func readJSON(conn *websocket.Conn, timeout time.Duration, v any) error {
	_ = conn.SetReadDeadline(time.Now().Add(timeout))
	typ, data, err := conn.ReadMessage()
	if err != nil {
		return err
	}
	if typ != websocket.TextMessage {
		return errors.New("消息格式错误")
	}
	return json.Unmarshal(data, v)
}

func writeJSON(conn *websocket.Conn, v any) error {
	_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	return conn.WriteJSON(v)
}

func lanError(conn *websocket.Conn, code, msg string) {
	_ = writeJSON(conn, map[string]any{"type": "error", "code": code, "message": msg})
	_ = conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.ClosePolicyViolation, code), time.Now().Add(time.Second))
	_ = conn.Close()
}

func b64(b []byte) string { return base64.StdEncoding.EncodeToString(b) }

func unb64(s string) []byte {
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		b, _ = base64.RawURLEncoding.DecodeString(s)
	}
	return b
}

func remoteIP(r *http.Request) string {
	h, _, _ := net.SplitHostPort(r.RemoteAddr)
	return h
}

func (s *Server) handlePair(w http.ResponseWriter, r *http.Request) {
	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()
	var hello struct {
		Type  string `json:"type"`
		Mode  string `json:"mode"` // qr / code
		Phone string `json:"phone"`
		Name  string `json:"name"`
		Pub   string `json:"pub"`
	}
	if err := readJSON(conn, 15*time.Second, &hello); err != nil || hello.Type != "pair" || hello.Phone == "" {
		lanError(conn, "bad_request", "配对请求格式错误")
		return
	}
	secret, err := s.LAN.Pairing.Begin()
	if err != nil {
		code := "not_open"
		if errors.Is(err, lan.ErrBusy) {
			code = "busy"
		}
		lanError(conn, code, err.Error())
		return
	}
	ok := false
	name := strings.TrimSpace(hello.Name)
	if name == "" {
		name = "手机"
	}
	defer func() {
		if !ok {
			s.LAN.Pairing.Finish(false, name)
		}
	}()

	curve := ecdh.X25519()
	peer, err := curve.NewPublicKey(unb64(hello.Pub))
	if err != nil {
		lanError(conn, "bad_request", "公钥格式错误")
		return
	}
	priv, err := curve.GenerateKey(rand.Reader)
	if err != nil {
		lanError(conn, "internal", err.Error())
		return
	}
	shared, err := priv.ECDH(peer)
	if err != nil {
		lanError(conn, "bad_request", "公钥无效")
		return
	}
	pcID := s.LAN.Store.PCID()
	pubPC := priv.PublicKey().Bytes()
	t := lan.Transcript(peer.Bytes(), pubPC, hello.Phone, pcID)
	if err := writeJSON(conn, map[string]any{"type": "pair", "pc": pcID, "name": s.pcName(), "os": runtime.GOOS, "osName": sysinfo.OSName(), "pub": b64(pubPC)}); err != nil {
		return
	}
	log.Printf("「%s」（%s）请求配对（%s）", name, remoteIP(r), map[string]string{"qr": "扫码", "code": "配对码"}[hello.Mode])

	var key, serverMAC []byte
	var expect []byte
	switch hello.Mode {
	case "qr":
		expect = lan.MAC(secret, []byte("c"), t)
		serverMAC = lan.MAC(secret, []byte("s"), t)
		key = lan.HKDF(shared, secret, append([]byte("p2d key"), t...), 32)
	case "code":
		s.LAN.Pairing.ShowCode(lan.SAS(shared, t), name)
		kconf := lan.HKDF(shared, t, []byte("p2d confirm"), 32)
		expect = lan.MAC(kconf, []byte("c"))
		serverMAC = lan.MAC(kconf, []byte("s"))
		key = lan.HKDF(shared, t, []byte("p2d key"), 32)
	default:
		lanError(conn, "bad_request", "不支持的配对方式")
		return
	}
	var confirm struct {
		Type string `json:"type"`
		MAC  string `json:"mac"`
	}
	// 配对码模式要等用户在手机上输入电脑显示的码
	if err := readJSON(conn, PairingDuration, &confirm); err != nil || confirm.Type != "confirm" {
		lanError(conn, "cancelled", "配对已取消")
		return
	}
	if !hmac.Equal(unb64(confirm.MAC), expect) {
		log.Printf("「%s」配对校验失败", name)
		lanError(conn, "mismatch", "配对校验失败：二维码已过期或配对码不一致")
		return
	}
	s.LAN.Store.Add(hello.Phone, name, key)
	ok = true
	s.LAN.Pairing.Finish(true, name)
	log.Printf("已与「%s」配对", name)
	info := s.pcInfo()
	info["type"] = "ok"
	info["mac"] = b64(serverMAC)
	_ = writeJSON(conn, info)
	s.changed()
	time.Sleep(200 * time.Millisecond)
}

// secureConn 加密的 WebSocket：外层只传二进制帧，明文的第一个字节是帧类型。
type secureConn struct {
	*websocket.Conn
	rd *lan.Cipher
	wr *lan.Cipher
}

func (c *secureConn) ReadMessage() (int, []byte, error) {
	typ, data, err := c.Conn.ReadMessage()
	if err != nil {
		return 0, nil, err
	}
	if typ != websocket.BinaryMessage {
		return 0, nil, errors.New("收到未加密的消息")
	}
	ft, pt, err := c.rd.Open(data)
	if err != nil {
		return 0, nil, err
	}
	if ft == lan.FrameBinary {
		return websocket.BinaryMessage, pt, nil
	}
	return websocket.TextMessage, pt, nil
}

func (c *secureConn) WriteMessage(typ int, data []byte) error {
	ft := lan.FrameText
	if typ == websocket.BinaryMessage {
		ft = lan.FrameBinary
	}
	return c.Conn.WriteMessage(websocket.BinaryMessage, c.wr.Seal(ft, data))
}

func (s *Server) handleSecure(w http.ResponseWriter, r *http.Request) {
	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	var hello struct {
		Type   string `json:"type"`
		Phone  string `json:"phone"`
		NC     string `json:"nc"`
		Manual bool   `json:"manual"` // 用户在手机上手动点了「连接」（不是自动重连）
		// 手机端支持的加密算法（新版手机端发 ["aes-gcm", "chacha20-poly1305"]）；没有时用 ChaCha20-Poly1305
		Ciphers []string `json:"ciphers"`
	}
	if err := readJSON(conn, 15*time.Second, &hello); err != nil || hello.Type != "hello" {
		lanError(conn, "bad_request", "握手格式错误")
		return
	}
	if s.lanSuppressed.Load() {
		if !hello.Manual {
			lanError(conn, "suppressed", "电脑端已断开连接，请在手机上手动点「连接」")
			return
		}
		s.lanSuppressed.Store(false)
	}
	nc := unb64(hello.NC)
	key, name, ok := s.LAN.Store.Key(hello.Phone)
	if !ok || len(nc) < 16 {
		lanError(conn, "unpaired", "这台电脑没有和这部手机配对（或已取消配对），请重新配对")
		return
	}
	ns := lan.Random(rand.Reader, 16)
	helloMsg := map[string]any{"type": "hello", "pc": s.LAN.Store.PCID(), "name": s.pcName(), "os": runtime.GOOS, "osName": sysinfo.OSName(), "ns": b64(ns)}
	algo := ""
	for _, c := range hello.Ciphers {
		if c == lan.CipherAESGCM {
			algo = c
			helloMsg["cipher"] = c
			break
		}
	}
	s.addMachineID(helloMsg)
	if err := writeJSON(conn, helloMsg); err != nil {
		_ = conn.Close()
		return
	}
	c2s, s2c := lan.SessionKeys(key, nc, ns)
	rd, _ := lan.NewCipherFor(algo, c2s)
	wr, _ := lan.NewCipherFor(algo, s2c)
	sc := &secureConn{Conn: conn, rd: rd, wr: wr}
	_ = conn.SetReadDeadline(time.Time{})

	id := atomic.AddInt64(&s.nextID, 1)
	sess := newSession(id, "lan:"+hello.Phone, sc, s.reg)
	sess.server = s
	sess.route = "wifi"
	sess.owner = hello.Phone
	sess.name = name
	s.LAN.Store.Touch(hello.Phone)
	log.Printf("[会话 %d] 「%s」通过局域网连接（%s）", id, name, remoteIP(r))
	s.runSession(sess, conn)
}

// pairingStatus 状态接口里的配对信息（含二维码内容）。
func (s *Server) lanStatus() map[string]any {
	if s.LAN == nil || s.LAN.Store == nil {
		return map[string]any{"enabled": false}
	}
	addrs := lan.Addrs()
	p := s.LAN.Pairing.Info()
	pairing := map[string]any{"active": p.Active, "state": p.State, "code": p.Code, "phoneName": p.PhoneName}
	if p.Active {
		pairing["expiresAt"] = p.ExpiresAt
		q := url.Values{}
		q.Set("h", strings.Join(addrs, ","))
		q.Set("p", fmt.Sprint(s.LAN.Port))
		q.Set("id", s.LAN.Store.PCID())
		q.Set("n", s.pcName())
		q.Set("s", p.Secret)
		pairing["qr"] = "p2d://pair?" + q.Encode()
	}
	st := map[string]any{
		"enabled": s.LAN.Port > 0,
		"port":    s.LAN.Port,
		"addrs":   addrs,
		"pcId":    s.LAN.Store.PCID(),
		"pairing": pairing,
		"paired":  s.LAN.Store.List(),
	}
	// Tailscale 地址单独给出，界面上提示用户：手机也装 Tailscale 时，不在同一个 WiFi 也能输入这个地址连接
	for _, a := range addrs {
		if lan.IsTailscale(a) {
			st["tailscale"] = a
			break
		}
	}
	return st
}

func (s *Server) handlePairingAPI(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if s.LAN == nil || s.LAN.Store == nil {
		http.Error(w, "局域网直连未开启", http.StatusServiceUnavailable)
		return
	}
	switch r.URL.Path {
	case "/api/pairing/start":
		s.LAN.Pairing.Start(PairingDuration)
	case "/api/pairing/cancel":
		s.LAN.Pairing.Cancel()
	case "/api/paired/remove":
		id := r.URL.Query().Get("id")
		if !s.LAN.Store.Remove(id) {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		s.CloseSerial("lan:"+id, "电脑端已取消配对")
	}
	s.changed()
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(s.lanStatus())
}
