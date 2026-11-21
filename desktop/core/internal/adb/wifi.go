// WiFi 局域网连接：手机插着数据线时把手机的 adb 切到网络模式（adb tcpip），并记下手机的局域网地址；
// 拔掉数据线后电脑自动 adb connect 过去，隧道、令牌、Deep Link 仍走原来的流程，手机端无需改动。
// 同一台手机的 USB 和 WiFi 两条通道用 ro.serialno 识别为同一台，USB 优先。
// 安全：adb 网络连接同样需要手机上已授权本机的 adb 密钥；电脑端服务本身仍只监听 127.0.0.1。
package adb

import (
	"context"
	"encoding/json"
	"log"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	// wifiGrace 拔线后等待 WiFi 接上的时间，期间令牌保留，手机端用原令牌自动重连
	wifiGrace = 25 * time.Second
	// 平时（手机不在线时）尝试 WiFi 连接的间隔；拔线刚发生时更频繁
	dialIdle = 15 * time.Second
	dialFast = 2 * time.Second
)

// Transport 设备通道。
const (
	TransportUSB  = "usb"
	TransportWiFi = "wifi"
)

// peer 记住的一台可以通过 WiFi 连接的手机。
type peer struct {
	ID      string    `json:"id"`   // ro.serialno
	Addr    string    `json:"addr"` // ip:port
	Model   string    `json:"model,omitempty"`
	Updated time.Time `json:"updated"`

	suppressed bool      // 用户点了「断开」，插线前不再自动连
	dialing    bool      // 正在 adb connect
	lastDial   time.Time // 上次尝试
	holdUntil  time.Time // 手机 adb 正在重启，暂不连接
	failLogged bool
}

// phone 已下发令牌的手机（按 ro.serialno）。
type phone struct {
	token  string
	lostAt time.Time // 所有通道都断开的时刻；零值表示在线
}

var serialHostPort = regexp.MustCompile(`^[0-9a-fA-F.:\[\]]+:\d+$`)

// transportOf 根据 adb 序列号判断通道类型：ip:port 或无线调试的 mDNS 名称为 WiFi。
func transportOf(serial string) string {
	if serialHostPort.MatchString(serial) || strings.Contains(serial, "._adb-tls-connect.") {
		return TransportWiFi
	}
	return TransportUSB
}

var ifaceLine = regexp.MustCompile(`^\d+:\s+([^:@\s]+)`)
var inetLine = regexp.MustCompile(`^inet\s+(\d+\.\d+\.\d+\.\d+)/`)

// parseWlanIP 从手机上 `ip -f inet addr show` 的输出中找 WiFi（wlan*）网卡的 IPv4 地址。
func parseWlanIP(out string) string {
	iface := ""
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if m := ifaceLine.FindStringSubmatch(line); m != nil {
			iface = m[1]
			continue
		}
		m := inetLine.FindStringSubmatch(line)
		if m == nil || !strings.HasPrefix(iface, "wlan") {
			continue
		}
		if ip := net.ParseIP(m[1]); ip != nil && !ip.IsLoopback() && !ip.IsLinkLocalUnicast() {
			return m[1]
		}
	}
	return ""
}

// connectOK 判断 `adb connect` 的输出是否表示连上了。
func connectOK(out string) bool {
	o := strings.ToLower(out)
	if strings.Contains(o, "failed") || strings.Contains(o, "cannot") || strings.Contains(o, "unable") || strings.Contains(o, "refused") {
		return false
	}
	return strings.Contains(o, "connected to")
}

// ---- 记住的手机（持久化到配置目录，电脑端重启后也能直接通过 WiFi 连）----

func (m *Manager) peersFile() string {
	if m.cfg.StateDir == "" {
		return ""
	}
	return filepath.Join(m.cfg.StateDir, "wifi-peers.json")
}

func (m *Manager) loadPeers() {
	f := m.peersFile()
	if f == "" {
		return
	}
	b, err := os.ReadFile(f)
	if err != nil {
		return
	}
	var list []*peer
	if err := json.Unmarshal(b, &list); err != nil {
		return
	}
	m.mu.Lock()
	for _, p := range list {
		if p.ID != "" && p.Addr != "" {
			m.peers[p.ID] = p
		}
	}
	m.mu.Unlock()
	if len(list) > 0 {
		log.Printf("已记住 %d 台可通过 WiFi 连接的手机", len(list))
	}
}

func (m *Manager) savePeers() {
	f := m.peersFile()
	if f == "" {
		return
	}
	m.mu.Lock()
	list := make([]peer, 0, len(m.peers))
	for _, p := range m.peers {
		list = append(list, peer{ID: p.ID, Addr: p.Addr, Model: p.Model, Updated: p.Updated})
	}
	m.mu.Unlock()
	b, _ := json.MarshalIndent(list, "", "  ")
	if err := os.MkdirAll(filepath.Dir(f), 0o700); err == nil {
		_ = os.WriteFile(f, b, 0o600)
	}
}

// rememberPeer 记下手机当前的局域网地址；同一地址之前属于别的手机的记录作废（DHCP 重新分配了）。
func (m *Manager) rememberPeer(id, addr, model string) {
	m.mu.Lock()
	for k, p := range m.peers {
		if p.Addr == addr && k != id {
			delete(m.peers, k)
		}
	}
	p := m.peers[id]
	if p == nil {
		p = &peer{ID: id}
		m.peers[id] = p
	}
	changed := p.Addr != addr || p.Model != model
	p.Addr, p.Model, p.Updated = addr, model, time.Now()
	p.suppressed = false
	m.mu.Unlock()
	if changed {
		log.Printf("设备 %s：已记住局域网地址 %s，拔掉数据线后会自动通过 WiFi 连接", id, addr)
	}
	m.savePeers()
}

// prepareWiFi 插着数据线时调用：记下手机的 WiFi 地址，必要时把手机 adb 切到网络模式。
// 切换会让手机 adb 重启、USB 通道断开一两秒，这里等它回来后再返回。
func (m *Manager) prepareWiFi(ctx context.Context, serial, id, model string) {
	out, err := m.run(ctx, 5*time.Second, "-s", serial, "shell", "ip", "-f", "inet", "addr", "show")
	ip := parseWlanIP(out)
	if err != nil || ip == "" {
		log.Printf("设备 %s：手机没有连接 WiFi，暂不能通过局域网连接", serial)
		return
	}
	port := strings.TrimSpace(func() string {
		s, _ := m.run(ctx, 5*time.Second, "-s", serial, "shell", "getprop", "service.adb.tcp.port")
		return s
	}())
	want := strconv.Itoa(m.cfg.WiFiPort)
	m.rememberPeer(id, net.JoinHostPort(ip, want), model)
	if port == want {
		return
	}

	hold := time.Now().Add(45 * time.Second)
	m.mu.Lock()
	m.restarting[serial] = hold
	if p := m.peers[id]; p != nil {
		p.holdUntil = hold
	}
	m.mu.Unlock()
	defer func() {
		m.mu.Lock()
		delete(m.restarting, serial)
		m.mu.Unlock()
	}()

	m.setStage(serial, StageStarting, "正在开启 WiFi 连接")
	if _, err := m.run(ctx, 10*time.Second, "-s", serial, "tcpip", want); err != nil {
		log.Printf("设备 %s：开启局域网调试失败：%v", serial, err)
		return
	}
	log.Printf("设备 %s：已开启局域网调试（端口 %s），等待手机 adb 重启", serial, want)
	// 手机 adb 重启需要一点时间（有的手机十几秒后才重启），先等它断开，再等它重新出现
	if m.waitState(ctx, serial, false, 20*time.Second) {
		m.waitState(ctx, serial, true, 20*time.Second)
	}
}

// waitState 等待设备进入（online=true）或离开（online=false）device 状态。
func (m *Manager) waitState(ctx context.Context, serial string, online bool, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		m.mu.Lock()
		d, ok := m.devices[serial]
		ready := ok && d.State == "device"
		m.mu.Unlock()
		if ready == online {
			return true
		}
		if !sleep(ctx, 500*time.Millisecond) {
			return false
		}
	}
	return false
}

// dial 尝试通过 WiFi 连接一台记住的手机。
func (m *Manager) dial(ctx context.Context, id, addr string, urgent bool) {
	defer func() {
		m.mu.Lock()
		if p := m.peers[id]; p != nil {
			p.dialing = false
		}
		m.mu.Unlock()
	}()
	// 掉线后残留的离线通道先断开，否则 connect 会一直报 already connected
	m.mu.Lock()
	d, ok := m.devices[addr]
	stale := ok && d.State != "device"
	m.mu.Unlock()
	if stale {
		_, _ = m.run(ctx, 3*time.Second, "disconnect", addr)
	}
	out, err := m.run(ctx, 8*time.Second, "connect", addr)
	m.mu.Lock()
	p := m.peers[id]
	if err == nil && connectOK(out) {
		m.dialed[addr] = id
		if p != nil {
			p.failLogged = false
		}
		m.mu.Unlock()
		log.Printf("设备 %s：已通过 WiFi 连接（%s）", id, addr)
		return
	}
	logIt := urgent && p != nil && !p.failLogged
	if p != nil && logIt {
		p.failLogged = true
	}
	m.mu.Unlock()
	if logIt {
		log.Printf("设备 %s：暂时连不上 %s（%s），手机和电脑需要在同一个局域网，会继续重试", id, addr, strings.TrimSpace(out))
	}
}

// checkPhones 每次轮询后调用：处理拔线后的令牌保留 / 作废，以及自动 WiFi 连接。
func (m *Manager) checkPhones(ctx context.Context) bool {
	now := time.Now()
	m.mu.Lock()
	alive := map[string]bool{}
	usbPresent := map[string]bool{} // 插着数据线（可能还在识别中）的手机，不用再连 WiFi
	for _, d := range m.devices {
		if d.State == "device" && d.ID != "" {
			alive[d.ID] = true
		}
		if d.Transport == TransportUSB {
			usbPresent[d.Serial] = true
			if d.ID != "" {
				usbPresent[d.ID] = true
			}
		}
	}
	var lost []string
	for id, ph := range m.phones {
		if alive[id] {
			ph.lostAt = time.Time{}
			continue
		}
		p := m.peers[id]
		canWiFi := m.cfg.WiFi && p != nil && !p.suppressed
		if ph.lostAt.IsZero() {
			ph.lostAt = now
			if canWiFi {
				log.Printf("设备 %s：数据线已断开，正在尝试通过 WiFi 连接（%s）", id, p.Addr)
			}
		}
		grace := time.Duration(0)
		if canWiFi {
			grace = wifiGrace
		}
		if now.Sub(ph.lostAt) >= grace {
			lost = append(lost, id)
			delete(m.phones, id)
		}
	}
	type dialJob struct {
		id, addr string
		urgent   bool
	}
	var jobs []dialJob
	if m.cfg.WiFi {
		for id, p := range m.peers {
			if alive[id] || usbPresent[id] || p.suppressed || p.dialing || now.Before(p.holdUntil) {
				continue
			}
			ph, hasToken := m.phones[id]
			urgent := hasToken && !ph.lostAt.IsZero()
			interval := dialIdle
			if urgent {
				interval = dialFast
			}
			if now.Sub(p.lastDial) < interval {
				continue
			}
			p.dialing = true
			p.lastDial = now
			jobs = append(jobs, dialJob{id, p.Addr, urgent})
		}
	}
	m.mu.Unlock()

	for _, id := range lost {
		log.Printf("设备 %s 已断开", id)
		m.tokens.Revoke(id)
		if m.OnGone != nil {
			m.OnGone(id)
		}
	}
	for _, j := range jobs {
		go m.dial(ctx, j.id, j.addr, j.urgent)
	}
	return len(lost) > 0
}

// ensureSession 通道切换后手机端通常会用原令牌自动重连；如果一段时间后还没连上（App 被系统杀掉等），重新拉起 App。
func (m *Manager) ensureSession(ctx context.Context, serial, id, token string) {
	if m.HasSession == nil {
		return
	}
	deadline := time.Now().Add(40 * time.Second)
	for time.Now().Before(deadline) {
		if m.HasSession(id) {
			return
		}
		if !sleep(ctx, time.Second) || m.suppressed(serial) {
			return
		}
		m.mu.Lock()
		_, still := m.phones[id]
		m.mu.Unlock()
		if !still {
			return
		}
	}
	log.Printf("设备 %s：手机端没有自动重连，重新启动 App", id)
	_ = m.launchApp(ctx, serial, token)
}

func sleep(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}
