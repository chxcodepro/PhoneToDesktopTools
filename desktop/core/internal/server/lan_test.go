package server

import (
	"crypto/ecdh"
	"crypto/hmac"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"p2d/core/internal/lan"
	"p2d/core/internal/tools"
)

func newLANServer(t *testing.T) (*Server, string) {
	srv := New(tools.NewRegistry(), NewTokenStore(""))
	srv.LAN = &LANConfig{Store: lan.OpenStore(""), Pairing: lan.NewPairingWindow(nil), Port: 39272}
	ts := httptest.NewServer(srv.LANHandler())
	t.Cleanup(ts.Close)
	return srv, "ws" + strings.TrimPrefix(ts.URL, "http")
}

func lanDial(t *testing.T, url string) *websocket.Conn {
	c, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	return c
}

func recv(t *testing.T, c *websocket.Conn) map[string]any {
	_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
	var m map[string]any
	if err := c.ReadJSON(&m); err != nil {
		t.Fatal(err)
	}
	return m
}

// checkMID 电脑信息里应带上机器指纹 mid（本机取不到系统标识时不带）
func checkMID(t *testing.T, srv *Server, m map[string]any) {
	t.Helper()
	want := srv.LAN.Store.MachineID()
	got, has := m["mid"]
	if want == "" {
		if has {
			t.Errorf("没有机器指纹时不应带 mid：%v", m)
		}
		return
	}
	if got != want {
		t.Errorf("mid 不对：%v，应为 %s", got, want)
	}
}

func TestPCInfoHasMachineID(t *testing.T) {
	srv, _ := newLANServer(t)
	info := srv.pcInfo()
	if info["pc"] != srv.LAN.Store.PCID() {
		t.Fatalf("pc 不对：%v", info)
	}
	checkMID(t, srv, info)
}

// pair 模拟手机配对，返回配对密钥
func pair(t *testing.T, srv *Server, url, mode, phoneID string) []byte {
	c := lanDial(t, url+"/p2d/pair")
	priv, _ := ecdh.X25519().GenerateKey(rand.Reader)
	pub := priv.PublicKey().Bytes()
	_ = c.WriteJSON(map[string]any{"type": "pair", "mode": mode, "phone": phoneID, "name": "测试手机", "pub": b64(pub)})
	m := recv(t, c)
	if m["type"] != "pair" {
		t.Fatalf("配对被拒绝：%v", m)
	}
	pcPub, _ := ecdh.X25519().NewPublicKey(unb64(m["pub"].(string)))
	shared, _ := priv.ECDH(pcPub)
	tr := lan.Transcript(pub, pcPub.Bytes(), phoneID, m["pc"].(string))
	var mac, key, serverMAC []byte
	if mode == "qr" {
		secret, _ := base64.RawURLEncoding.DecodeString(srv.LAN.Pairing.Info().Secret)
		mac = lan.MAC(secret, []byte("c"), tr)
		serverMAC = lan.MAC(secret, []byte("s"), tr)
		key = lan.HKDF(shared, secret, append([]byte("p2d key"), tr...), 32)
	} else {
		// 电脑上显示的码必须和手机算出来的一致
		time.Sleep(50 * time.Millisecond)
		if got, want := srv.LAN.Pairing.Info().Code, lan.SAS(shared, tr); got != want {
			t.Fatalf("配对码不一致：电脑 %s 手机 %s", got, want)
		}
		kconf := lan.HKDF(shared, tr, []byte("p2d confirm"), 32)
		mac = lan.MAC(kconf, []byte("c"))
		serverMAC = lan.MAC(kconf, []byte("s"))
		key = lan.HKDF(shared, tr, []byte("p2d key"), 32)
	}
	_ = c.WriteJSON(map[string]any{"type": "confirm", "mac": b64(mac)})
	ok := recv(t, c)
	if ok["type"] != "ok" || !hmac.Equal(unb64(ok["mac"].(string)), serverMAC) {
		t.Fatalf("配对确认失败：%v", ok)
	}
	checkMID(t, srv, ok)
	return key
}

// secureCall 建立加密会话并调用 initialize
func secureCall(t *testing.T, url, phoneID string, key []byte, manual bool) (map[string]any, error) {
	c := lanDial(t, url+"/p2d/secure")
	nc := lan.Random(rand.Reader, 16)
	_ = c.WriteJSON(map[string]any{"type": "hello", "phone": phoneID, "nc": b64(nc), "manual": manual})
	h := recv(t, c)
	if h["type"] != "hello" {
		return h, nil
	}
	if mid := h["mid"]; mid != nil && mid == "" {
		t.Errorf("hello 里的 mid 不应为空字符串：%v", h)
	}
	c2s, s2c := lan.SessionKeys(key, nc, unb64(h["ns"].(string)))
	wr, _ := lan.NewCipher(c2s)
	rd, _ := lan.NewCipher(s2c)
	req, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": map[string]any{"protocolVersion": "2025-06-18"}})
	_ = c.WriteMessage(websocket.BinaryMessage, wr.Seal(lan.FrameText, req))
	_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
	_, data, err := c.ReadMessage()
	if err != nil {
		return nil, err
	}
	_, pt, err := rd.Open(data)
	if err != nil {
		return nil, err
	}
	var m map[string]any
	_ = json.Unmarshal(pt, &m)
	return m, nil
}

func TestLANPairingAndSecureSession(t *testing.T) {
	srv, url := newLANServer(t)

	// 没打开配对窗口
	c := lanDial(t, url+"/p2d/pair")
	_ = c.WriteJSON(map[string]any{"type": "pair", "mode": "qr", "phone": "x", "pub": b64(make([]byte, 32))})
	if m := recv(t, c); m["code"] != "not_open" {
		t.Fatalf("应拒绝：%v", m)
	}

	srv.LAN.Pairing.Start(time.Minute)
	key := pair(t, srv, url, "qr", "phone-qr")
	if _, _, ok := srv.LAN.Store.Key("phone-qr"); !ok {
		t.Fatal("扫码配对后应保存")
	}
	if srv.LAN.Pairing.Info().Active {
		t.Fatal("配对成功后窗口应关闭")
	}

	srv.LAN.Pairing.Start(time.Minute)
	key2 := pair(t, srv, url, "code", "phone-code")

	m, err := secureCall(t, url, "phone-qr", key, false)
	if err != nil || m["result"] == nil {
		t.Fatalf("加密会话失败：%v %v", err, m)
	}
	info := m["result"].(map[string]any)["serverInfo"].(map[string]any)
	if info["name"] != "p2d-core" {
		t.Fatalf("握手结果不对：%v", m)
	}
	if m, err := secureCall(t, url, "phone-code", key2, false); err != nil || m["result"] == nil {
		t.Fatalf("配对码配对的手机连接失败：%v %v", err, m)
	}

	// 密钥不对：服务端解密失败直接断开
	if _, err := secureCall(t, url, "phone-qr", key2, false); err == nil {
		t.Fatal("密钥错误应连接失败")
	}
	// 未配对
	if m, _ := secureCall(t, url, "nobody", key, false); m["code"] != "unpaired" {
		t.Fatalf("未配对应拒绝：%v", m)
	}
	// 电脑上点了断开：自动重连被拒绝，手动连接可以
	srv.DisconnectAll()
	if m, _ := secureCall(t, url, "phone-qr", key, false); m["code"] != "suppressed" {
		t.Fatalf("断开后自动重连应被拒绝：%v", m)
	}
	if m, err := secureCall(t, url, "phone-qr", key, true); err != nil || m["result"] == nil {
		t.Fatalf("手动连接应成功：%v %v", err, m)
	}
}
