// Package iphone iPhone 数据线连接：经 usbmuxd（见 internal/usbmux）连到 iPhone 上 P2D App 监听的端口，
// 在这条连接上跑和免调试连接相同的多路复用协议（internal/aoa 的链路），效果和安卓的 adb reverse 隧道一样：
// iPhone 上的 App 照旧用 ws://127.0.0.1:<端口>/mcp?token=… 连接电脑。
//
// 和安卓的区别：电脑不能给 iPhone 装 App、也不能把 App 拉起来，用户要自己打开 App 并保持在前台
// （iOS 会在 App 切到后台不久后挂起它，连接随之断开，回到前台后自动重连）。
package iphone

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"p2d/core/internal/aoa"
	"p2d/core/internal/usbmux"
)

// PhonePort iPhone 上 App 监听的端口（只在 iPhone 本机回环地址上，电脑经 usbmuxd 连接）。
// 手机端 mobile/modules/p2d-accessory/ios 里的端口要和这里一致。
const PhonePort = 39274

// TransportUSBMux 设备通道名
const TransportUSBMux = "usbmux"

// 设备阶段，和 internal/adb、internal/aoa 的取值一致，电脑端界面共用
const (
	StageStarting   = aoa.StageStarting
	StageReady      = aoa.StageReady
	StageSuppressed = aoa.StageSuppressed
	StageError      = aoa.StageError
)

const (
	msgOpenApp   = "请在 iPhone 上打开 P2D App 并保持在前台（第一次插线时 iPhone 上弹出「要信任此电脑吗？」请点「信任」）"
	msgOffSwitch = "已断开，重新插拔数据线可再次连接"
)

// pollInterval 多久查一次插着的 iPhone、重试一次连接（测试里会改短）
var pollInterval = 2 * time.Second

// Device 设备状态（和 adb.Device、aoa.Device 的 JSON 字段一致）
type Device struct {
	Serial    string `json:"serial"` // ios:<UDID>
	ID        string `json:"id,omitempty"`
	Transport string `json:"transport"`
	Model     string `json:"model"`
	State     string `json:"state"`
	Stage     string `json:"stage"`
	Message   string `json:"message,omitempty"`
	Platform  string `json:"platform"` // 固定为 ios，界面据此显示 iPhone 的说明
}

// Config 管理器配置
type Config struct {
	Port     int    // 本机服务端口
	HostName string // 显示在手机上的电脑名
	PCID     string
}

type entry struct {
	muxID  int
	cancel context.CancelFunc
	lnk    *aoa.Link
	Device
}

// Manager 发现插着的 iPhone，维护到 App 的链路
type Manager struct {
	cfg    Config
	tokens aoa.TokenIssuer

	// 可替换，测试用
	list    func() ([]usbmux.Device, error)
	connect func(deviceID, port int) (net.Conn, error)
	present func() bool // 系统里有没有插着苹果设备（usbmuxd 不可用时用来判断要不要提示安装）

	mu         sync.Mutex
	entries    map[string]*entry // UDID → 设备
	issued     map[string]string // 串号 → 令牌
	suppressed map[string]bool   // 用户点了断开的 iPhone，拔线前不再连接
	problem    string

	OnGone   func(serial string) // iPhone 拔出：服务端断开它的会话
	OnChange func()
}

// New 创建管理器
func New(cfg Config, tokens aoa.TokenIssuer) *Manager {
	return &Manager{
		cfg: cfg, tokens: tokens,
		list: usbmux.List, connect: usbmux.Connect, present: applePresent,
		entries: map[string]*entry{}, issued: map[string]string{}, suppressed: map[string]bool{},
	}
}

func (m *Manager) changed() {
	if m.OnChange != nil {
		m.OnChange()
	}
}

// Run 运行到 ctx 结束
func (m *Manager) Run(ctx context.Context) {
	t := time.NewTicker(pollInterval)
	defer t.Stop()
	for {
		m.poll(ctx)
		select {
		case <-ctx.Done():
			m.mu.Lock()
			for _, e := range m.entries {
				e.cancel()
			}
			m.mu.Unlock()
			return
		case <-t.C:
		}
	}
}

// missingHint usbmuxd 不可用、但插着苹果设备时的提示
func missingHint() string {
	switch runtime.GOOS {
	case "windows":
		return "插着 iPhone，但这台电脑没有苹果的设备支持：请从 Microsoft Store 安装「Apple 设备」（Windows 7 / 8 安装 iTunes），装好后重新插拔数据线。也可以改用 WiFi 连接"
	case "linux":
		return "插着 iPhone，但这台电脑没有 usbmuxd：请安装 usbmuxd 软件包（如 sudo apt install usbmuxd），然后重新插拔数据线。也可以改用 WiFi 连接"
	default:
		return "插着 iPhone，但连不上系统的 usbmuxd 服务，请重新插拔数据线或重启电脑"
	}
}

func (m *Manager) poll(ctx context.Context) {
	devs, err := m.list()
	problem := ""
	if err != nil {
		devs = nil
		if errors.Is(err, usbmux.ErrUnavailable) {
			if m.present != nil && m.present() {
				problem = missingHint()
			}
		} else {
			problem = "读取 iPhone 列表失败：" + err.Error()
		}
	}
	seen := map[string]usbmux.Device{}
	for _, d := range devs {
		if d.USB && d.Serial != "" {
			seen[d.Serial] = d
		}
	}

	var gone []string
	upd := false
	m.mu.Lock()
	if m.problem != problem {
		m.problem = problem
		upd = true
		if problem != "" {
			log.Printf("iPhone：%s", problem)
		}
	}
	for udid, e := range m.entries {
		d, ok := seen[udid]
		if ok && d.ID == e.muxID {
			continue
		}
		// 拔出（或重新插过，usbmuxd 换了编号）：结束旧链路，作废令牌
		e.cancel()
		delete(m.entries, udid)
		delete(m.suppressed, udid)
		delete(m.issued, e.Serial)
		m.tokens.Revoke(e.Serial)
		gone = append(gone, e.Serial)
		upd = true
	}
	for udid, d := range seen {
		if _, ok := m.entries[udid]; ok {
			continue
		}
		cctx, cancel := context.WithCancel(ctx)
		e := &entry{muxID: d.ID, cancel: cancel, Device: Device{
			Serial: "ios:" + udid, ID: udid, Transport: TransportUSBMux, Model: "iPhone",
			State: "device", Stage: StageStarting, Message: msgOpenApp, Platform: "ios",
		}}
		m.entries[udid] = e
		log.Printf("iPhone：发现 %s，等待 App 打开", udid)
		go m.runDevice(cctx, e)
		upd = true
	}
	m.mu.Unlock()
	for _, s := range gone {
		log.Printf("iPhone：%s 已拔出", s)
		if m.OnGone != nil {
			m.OnGone(s)
		}
	}
	if upd {
		m.changed()
	}
}

// runDevice 反复尝试连接 iPhone 上的 App；连上后运行链路，断开后继续尝试，直到拔线
func (m *Manager) runDevice(ctx context.Context, e *entry) {
	refusedLogged := false
	for ctx.Err() == nil {
		c, err := m.connect(e.muxID, PhonePort)
		if err != nil {
			switch {
			case errors.Is(err, usbmux.ErrRefused):
				// App 没打开或在后台被挂起：正常情况，安静地重试
				if !refusedLogged {
					refusedLogged = true
					log.Printf("iPhone：%s 上的 App 还没打开", e.ID)
				}
				m.setStage(e, StageStarting, msgOpenApp)
			case errors.Is(err, usbmux.ErrNoDevice):
				m.setStage(e, StageStarting, msgOpenApp)
			default:
				m.setStage(e, StageError, "连接 iPhone 失败："+err.Error())
			}
		} else {
			refusedLogged = false
			log.Printf("iPhone：已连上 %s 上的 App", e.ID)
			l := aoa.NewLink(&connTransport{c: c}, aoa.Hooks{
				Dial: func() (net.Conn, error) {
					return net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", m.cfg.Port), 5*time.Second)
				},
				Config:    func(h aoa.Hello) (aoa.LinkConfig, bool) { return m.configFor(e, h) },
				Hello:     func(h aoa.Hello, configured bool) { m.onHello(e, h, configured) },
				PhoneGone: func() { m.setStage(e, StageStarting, msgOpenApp) },
			})
			m.mu.Lock()
			e.lnk = l
			m.mu.Unlock()
			err := l.Run(ctx)
			m.mu.Lock()
			e.lnk = nil
			m.mu.Unlock()
			if ctx.Err() == nil {
				log.Printf("iPhone：%s 的连接中断（App 切到后台或被关闭）：%v", e.ID, err)
				m.setStage(e, StageStarting, msgOpenApp)
			}
		}
		select {
		case <-ctx.Done():
		case <-time.After(pollInterval):
		}
	}
}

// configFor App 已打开：发令牌（同一次插线期间不变，App 重开后用原令牌重连）
func (m *Manager) configFor(e *entry, h aoa.Hello) (aoa.LinkConfig, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.suppressed[e.ID] {
		return aoa.LinkConfig{}, false
	}
	tok, ok := m.issued[e.Serial]
	if !ok {
		tok = m.tokens.Issue(e.Serial)
		m.issued[e.Serial] = tok
	}
	log.Printf("iPhone：%s（%s）已打开 App，发送连接参数", e.ID, h.Name)
	return aoa.LinkConfig{Token: tok, Host: m.cfg.HostName, OS: runtime.GOOS, PCID: m.cfg.PCID}, true
}

func (m *Manager) onHello(e *entry, h aoa.Hello, configured bool) {
	m.mu.Lock()
	upd := false
	if name := strings.TrimSpace(h.Name); name != "" && name != e.Model {
		e.Model = name
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

// Snapshot 设备列表
func (m *Manager) Snapshot() []Device {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []Device{}
	for _, e := range m.entries {
		out = append(out, e.Device)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Serial < out[j].Serial })
	return out
}

// Devices 设备列表（服务端状态接口用）
func (m *Manager) Devices() any { return m.Snapshot() }

// Problem 不能经数据线连接 iPhone 的原因（正常时为空）
func (m *Manager) Problem() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.problem
}

// SuppressAll 用户在电脑上点了「断开」：拔线前不再连接（令牌由服务端统一作废）
func (m *Manager) SuppressAll() {
	m.mu.Lock()
	var links []*aoa.Link
	for udid, e := range m.entries {
		m.suppressed[udid] = true
		e.Stage, e.Message = StageSuppressed, msgOffSwitch
		if e.lnk != nil {
			links = append(links, e.lnk)
		}
	}
	m.issued = map[string]string{}
	m.mu.Unlock()
	for _, l := range links {
		l.Unconfigure()
	}
	m.changed()
}

// connTransport 把 usbmuxd 的连接包装成链路用的管道：读超时（1 秒）时返回 aoa.ErrTimeout，链路据此检查心跳
type connTransport struct{ c net.Conn }

func (t *connTransport) Read(p []byte) (int, error) {
	_ = t.c.SetReadDeadline(time.Now().Add(time.Second))
	n, err := t.c.Read(p)
	if n > 0 {
		return n, nil
	}
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() {
		return 0, aoa.ErrTimeout
	}
	return n, err
}

func (t *connTransport) Write(p []byte) error {
	// iPhone 上的 App 被挂起时写入可能一直卡住：超时就当连接断了，等 App 回到前台重连
	_ = t.c.SetWriteDeadline(time.Now().Add(15 * time.Second))
	_, err := t.c.Write(p)
	return err
}

func (t *connTransport) Close() error { return t.c.Close() }
