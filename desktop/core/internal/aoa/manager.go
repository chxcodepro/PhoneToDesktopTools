package aoa

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
)

// 设备阶段，和 internal/adb 的 Stage 取值一致，电脑端界面共用（另加 available）
const (
	StageAvailable  = "available"  // 插着一台没开 USB 调试的手机：在电脑端点「免调试连接」后连接
	StageStarting   = "starting"   // 正在切换配件模式 / 等手机上打开 App
	StageReady      = "ready"      // 已把令牌发给手机，等手机连接或已连上
	StageSuppressed = "suppressed" // 用户已断开，拔线前不再连接
	StageError      = "error"
)

// TransportAOA 设备通道名
const TransportAOA = "aoa"

// Device 设备状态（和 adb.Device 的 JSON 字段一致）
type Device struct {
	Serial    string `json:"serial"` // aoa:<USB 插口>
	ID        string `json:"id,omitempty"`
	Transport string `json:"transport"`
	Model     string `json:"model"`
	State     string `json:"state"` // device：配件已打开；available：可以免调试连接
	Stage     string `json:"stage"`
	Message   string `json:"message,omitempty"`
}

// TokenIssuer 由服务端令牌库实现
type TokenIssuer interface {
	Issue(serial string) string
	Revoke(serial string)
}

// Config 管理器配置
type Config struct {
	Port     int    // 本机服务端口（和 adb 隧道相同）
	HostName string // 显示在手机上的电脑名
	PCID     string
	StateDir string // 记住的手机（aoa.json）
	// ADBAvailable 能经 USB 调试连接时（internal/adb），开了 USB 调试的手机交给它（能自动装 App）；为空表示不能
	ADBAvailable func() bool
}

// 手机拔出（含切换配件模式时的短暂断开）多久后才算真的断开（测试里会改短）
var goneAfter = 8 * time.Second

const (
	msgAvailable = "没有开 USB 调试，可以免调试连接"
	msgSwitching = "正在切换到免调试连接…"
	msgOpenApp   = "请在手机上打开 p2d：弹出「用 p2d 打开」时点确定（勾上「默认」以后不再询问）。手机上还没装 App 的，按提示下载安装后重新插拔数据线"
	msgNoPerm    = "没有权限访问这台手机的 USB 设备：请用 deb 安装包重新安装电脑端（会添加 USB 权限规则），然后重新插拔数据线"
	msgOffSwitch = "已断开，重新插拔数据线可再次连接"

	msgSwitchTimeout = "手机没有切换到免调试连接：请解锁手机屏幕后再点一次"
)

// switchTimeout 发出切换请求后，手机多久内应该以配件身份重新出现
var switchTimeout = 10 * time.Second

type entry struct {
	dev       usbDevice
	accessory bool
	visible   bool // 是手机（探测通过）或配件
	noPerm    bool
	switched  bool // 已发过切换请求（每次插入只自动切换一次）
	switchAt  time.Time
	cancel    context.CancelFunc
	lnk       *link
	Device
}

// Manager 免调试连接：发现手机、切换配件模式、维护配件链路
type Manager struct {
	cfg    Config
	tokens TokenIssuer
	usb    usbBackend

	mu         sync.Mutex
	entries    map[string]*entry    // sysfs 名#设备号 → 设备
	issued     map[string]string    // 手机 ID → 令牌
	lastSeen   map[string]time.Time // 手机 ID → 最近一次看到（MTP 或配件）
	suppressed map[string]bool      // 用户点了断开的手机，拔线前不再连接
	known      map[string]knownPhone
	problem    string

	OnGone   func(id string) // 手机拔出：服务端断开它的会话
	OnChange func()
}

type knownPhone struct {
	Name string    `json:"name"`
	At   time.Time `json:"at"`
}

// New 创建管理器；系统不支持时返回 nil
func New(cfg Config, tokens TokenIssuer) *Manager {
	if !Supported {
		return nil
	}
	return newManager(cfg, tokens, newBackend())
}

func newManager(cfg Config, tokens TokenIssuer, usb usbBackend) *Manager {
	m := &Manager{
		cfg: cfg, tokens: tokens, usb: usb,
		entries: map[string]*entry{}, issued: map[string]string{}, lastSeen: map[string]time.Time{},
		suppressed: map[string]bool{}, known: map[string]knownPhone{},
	}
	m.loadKnown()
	return m
}

func (m *Manager) knownPath() string {
	if m.cfg.StateDir == "" {
		return ""
	}
	return filepath.Join(m.cfg.StateDir, "aoa.json")
}

func (m *Manager) loadKnown() {
	p := m.knownPath()
	if p == "" {
		return
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return
	}
	var v struct {
		Phones map[string]knownPhone `json:"phones"`
	}
	if json.Unmarshal(b, &v) == nil && v.Phones != nil {
		m.known = v.Phones
	}
}

// saveKnownLocked 调用方持有 m.mu
func (m *Manager) saveKnownLocked() {
	p := m.knownPath()
	if p == "" {
		return
	}
	b, _ := json.MarshalIndent(map[string]any{"phones": m.known}, "", "  ")
	_ = os.MkdirAll(filepath.Dir(p), 0o700)
	if err := os.WriteFile(p, b, 0o600); err != nil {
		log.Printf("免调试连接：保存记住的手机失败：%v", err)
	}
}

func (m *Manager) changed() {
	if m.OnChange != nil {
		m.OnChange()
	}
}

// Run 每秒扫描一次 USB 设备，直到 ctx 结束
func (m *Manager) Run(ctx context.Context) {
	t := time.NewTicker(time.Second)
	defer t.Stop()
	for {
		m.poll(ctx)
		select {
		case <-ctx.Done():
			m.mu.Lock()
			for _, e := range m.entries {
				if e.cancel != nil {
					e.cancel()
				}
			}
			m.mu.Unlock()
			return
		case <-t.C:
		}
	}
}

// phoneID 手机的标识：USB 序列号（安卓上就是 ro.serialno，和 adb 通道一致），没有时用插口
func phoneID(d usbDevice) string {
	if s := strings.TrimSpace(d.Serial); s != "" && !strings.ContainsAny(s, " :/") {
		return s
	}
	return "usb-" + d.Name
}

func entryKey(d usbDevice) string { return fmt.Sprintf("%s#%d", d.Name, d.Addr) }

func (m *Manager) adbHandles(d usbDevice) bool {
	return d.HasADB() && m.cfg.ADBAvailable != nil && m.cfg.ADBAvailable()
}

func (m *Manager) poll(ctx context.Context) {
	list, err := m.usb.List()
	changed := false
	m.mu.Lock()
	problem := ""
	if err != nil {
		problem = err.Error()
	}
	if problem != m.problem {
		m.problem = problem
		changed = true
		if problem != "" {
			log.Printf("免调试连接：无法读取 USB 设备列表：%v", err)
		}
	}
	m.mu.Unlock()
	if err != nil {
		if changed {
			m.changed()
		}
		return
	}

	now := time.Now()
	seen := map[string]bool{}
	var toProbe []*entry
	for _, d := range list {
		acc := isAccessory(d.VID, d.PID)
		// 开了 USB 调试的手机交给 USB 调试连接（internal/adb，含配件模式下又开了调试的 2D01）
		if m.adbHandles(d) || (!acc && !d.MaybePhone()) {
			continue
		}
		key := entryKey(d)
		seen[key] = true
		m.mu.Lock()
		e, ok := m.entries[key]
		if !ok {
			id := phoneID(d)
			e = &entry{dev: d, accessory: acc, Device: Device{
				Serial: "aoa:" + d.Name, ID: id, Transport: TransportAOA, Model: d.Product,
			}}
			if kp, ok := m.known[id]; ok && kp.Name != "" {
				e.Model = kp.Name
			}
			m.entries[key] = e
			changed = true
			if acc {
				e.visible = true
				e.State = "device"
				if m.suppressed[id] {
					e.Stage, e.Message = StageSuppressed, msgOffSwitch
				} else {
					e.Stage, e.Message = StageStarting, msgOpenApp
				}
				lctx, cancel := context.WithCancel(ctx)
				e.cancel = cancel
				log.Printf("免调试连接：手机 %s（%s）已切换到配件模式", id, d.Product)
				go m.runAccessory(lctx, e)
			} else {
				toProbe = append(toProbe, e)
			}
		}
		if e.visible {
			m.lastSeen[e.ID] = now
		}
		m.mu.Unlock()
	}
	for _, e := range toProbe {
		if m.probe(e) {
			changed = true
		}
	}
	// 发了切换请求，手机却一直没变成配件（锁屏时部分手机不响应等）：回到可点击状态
	m.mu.Lock()
	for _, e := range m.entries {
		if !e.accessory && e.Stage == StageStarting && now.Sub(e.switchAt) > switchTimeout {
			e.Stage, e.Message = StageAvailable, msgSwitchTimeout
			changed = true
		}
	}
	m.mu.Unlock()

	m.mu.Lock()
	for key, e := range m.entries {
		if seen[key] {
			continue
		}
		if e.cancel != nil {
			e.cancel()
		}
		delete(m.entries, key)
		if e.visible {
			changed = true
		}
	}
	// 拔出超过 goneAfter：作废令牌、断开会话、解除「已断开」
	var gone []string
	for id, t := range m.lastSeen {
		if now.Sub(t) < goneAfter {
			continue
		}
		delete(m.lastSeen, id)
		delete(m.suppressed, id)
		if _, ok := m.issued[id]; ok {
			delete(m.issued, id)
			gone = append(gone, id)
		}
	}
	m.mu.Unlock()
	for _, id := range gone {
		log.Printf("免调试连接：手机 %s 已拔出", id)
		m.tokens.Revoke(id)
		if m.OnGone != nil {
			m.OnGone(id)
		}
	}
	if changed || len(gone) > 0 {
		m.changed()
	}
}

// probe 新插上的设备：问它支不支持配件模式。支持就显示出来，记住过的手机直接切换
func (m *Manager) probe(e *entry) bool {
	v, err := m.usb.Probe(e.dev)
	m.mu.Lock()
	defer m.mu.Unlock()
	switch {
	case errors.Is(err, errPermission):
		// 打不开设备，判断不了是不是安卓手机；有 MTP / ADB 接口，大概率是，显示出来并说明原因
		e.visible, e.noPerm = true, true
		e.State, e.Stage, e.Message = "available", StageAvailable, msgNoPerm
		m.lastSeen[e.ID] = time.Now()
		return true
	case err != nil || v < 1:
		return false // 不是安卓手机（相机等）
	}
	e.visible = true
	e.State, e.Stage, e.Message = "available", StageAvailable, msgAvailable
	m.lastSeen[e.ID] = time.Now()
	if _, ok := m.known[e.ID]; ok && !m.suppressed[e.ID] {
		m.switchLocked(e)
	}
	return true
}

// switchLocked 让手机切换到配件模式。调用方持有 m.mu
func (m *Manager) switchLocked(e *entry) {
	if e.switched {
		return
	}
	e.switched = true
	e.switchAt = time.Now()
	e.Stage, e.Message = StageStarting, msgSwitching
	d := e.dev
	go func() {
		err := m.usb.Switch(d, [6]string{
			accessoryManufacturer, accessoryModel, accessoryDescription, accessoryVersion, accessoryURI, m.cfg.PCID,
		})
		if err == nil {
			log.Printf("免调试连接：已让手机 %s 切换到配件模式", e.ID)
			return
		}
		log.Printf("免调试连接：手机 %s 切换失败：%v", e.ID, err)
		m.mu.Lock()
		e.switched = false
		// 回到「可以免调试连接」，用户可以再点一次
		e.Stage, e.Message = StageAvailable, "切换免调试连接失败："+err.Error()
		if errors.Is(err, errPermission) {
			e.Message = msgNoPerm
		}
		m.mu.Unlock()
		m.changed()
	}()
}

// Connect 用户在电脑端点了「免调试连接」：记住这台手机（以后插上自动连），让它切换到配件模式
func (m *Manager) Connect(id string) error {
	m.mu.Lock()
	var target *entry
	for _, e := range m.entries {
		if e.visible && !e.accessory && (e.ID == id || e.Serial == id) {
			target = e
		}
	}
	if target == nil {
		m.mu.Unlock()
		return errors.New("没有找到这台手机，请确认数据线已插好")
	}
	if target.noPerm {
		m.mu.Unlock()
		return errors.New(msgNoPerm)
	}
	delete(m.suppressed, target.ID)
	m.known[target.ID] = knownPhone{Name: target.Model, At: time.Now()}
	m.saveKnownLocked()
	target.switched = false
	m.switchLocked(target)
	m.mu.Unlock()
	m.changed()
	return nil
}

// runAccessory 打开配件并运行链路；链路意外结束（手机端停止读取等）而设备还在时重新打开
func (m *Manager) runAccessory(ctx context.Context, e *entry) {
	for ctx.Err() == nil {
		t, err := m.usb.Open(e.dev)
		if err != nil {
			msg := "打开配件失败：" + err.Error()
			if errors.Is(err, errPermission) {
				msg = msgNoPerm
			}
			m.setStage(e, StageError, msg)
			log.Printf("免调试连接：手机 %s：%s", e.ID, msg)
		} else {
			l := newLink(t, linkHooks{
				dial: func() (net.Conn, error) {
					return net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", m.cfg.Port), 5*time.Second)
				},
				config:    func(h helloMsg) (configMsg, bool) { return m.configFor(e, h) },
				hello:     func(h helloMsg, configured bool) { m.onHello(e, h, configured) },
				phoneGone: func() { m.setStage(e, StageStarting, msgOpenApp) },
			})
			m.mu.Lock()
			e.lnk = l
			m.mu.Unlock()
			err = l.run(ctx)
			m.mu.Lock()
			e.lnk = nil
			m.mu.Unlock()
			if ctx.Err() == nil {
				log.Printf("免调试连接：手机 %s 的链路中断：%v", e.ID, err)
			}
		}
		select {
		case <-ctx.Done():
		case <-time.After(2 * time.Second):
		}
	}
}

// configFor 手机打开了配件：发令牌（同一次插线期间不变，手机端 App 重开后用原令牌重连）
func (m *Manager) configFor(e *entry, h helloMsg) (configMsg, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.suppressed[e.ID] {
		return configMsg{}, false
	}
	tok, ok := m.issued[e.ID]
	if !ok {
		tok = m.tokens.Issue(e.ID)
		m.issued[e.ID] = tok
	}
	log.Printf("免调试连接：手机 %s（%s）已打开 App，发送连接参数", e.ID, h.Name)
	return configMsg{Token: tok, Host: m.cfg.HostName, OS: runtime.GOOS, PCID: m.cfg.PCID}, true
}

func (m *Manager) onHello(e *entry, h helloMsg, configured bool) {
	m.mu.Lock()
	upd := false
	if name := strings.TrimSpace(h.Name); name != "" && name != e.Model {
		e.Model = name
		if kp, ok := m.known[e.ID]; ok && kp.Name != name {
			kp.Name = name
			m.known[e.ID] = kp
			m.saveKnownLocked()
		}
		upd = true
	}
	stage, msg := StageReady, ""
	if !configured {
		stage, msg = StageSuppressed, msgOffSwitch
	}
	if e.Stage != stage || e.Message != msg {
		e.Stage, e.Message = stage, msg
		upd = true
	}
	m.mu.Unlock()
	if upd {
		m.changed()
	}
}

func (m *Manager) setStage(e *entry, stage, msg string) {
	m.mu.Lock()
	if m.suppressed[e.ID] && stage != StageError {
		stage, msg = StageSuppressed, msgOffSwitch
	}
	upd := e.Stage != stage || e.Message != msg
	e.Stage, e.Message = stage, msg
	m.mu.Unlock()
	if upd {
		m.changed()
	}
}

// Snapshot 设备列表（状态接口用）
func (m *Manager) Snapshot() []Device {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []Device{}
	for _, e := range m.entries {
		if e.visible {
			out = append(out, e.Device)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Serial < out[j].Serial })
	return out
}

// Devices 设备列表（服务端状态接口用）
func (m *Manager) Devices() any { return m.Snapshot() }

// Problem 读不到 USB 设备列表的原因（正常时为空）
func (m *Manager) Problem() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.problem
}

// SuppressAll 用户在电脑上点了「断开」：拔线前不再连接（令牌由服务端统一作废）
func (m *Manager) SuppressAll() {
	m.mu.Lock()
	var links []*link
	for _, e := range m.entries {
		if !e.visible {
			continue
		}
		m.suppressed[e.ID] = true
		if e.accessory {
			e.Stage, e.Message = StageSuppressed, msgOffSwitch
			if e.lnk != nil {
				links = append(links, e.lnk)
			}
		} else if e.Stage == StageStarting {
			e.Stage, e.Message = StageAvailable, msgAvailable
		}
	}
	m.issued = map[string]string{}
	m.mu.Unlock()
	for _, l := range links {
		l.unconfigure()
	}
	m.changed()
}
