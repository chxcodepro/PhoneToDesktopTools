// Package adb 自动发现 USB 连接的安卓手机：自动安装 App、建立 adb reverse 隧道、通过 Deep Link 下发令牌并启动 App。
// 令牌和会话按手机（ro.serialno）而不是按通道区分，见 phones.go。WiFi 连接改由局域网直连（internal/lan）完成。
package adb

import (
	"bytes"
	"context"
	"fmt"
	"log"
	"net/url"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"time"

	"p2d/core/internal/procutil"
)

// Stage 设备所处阶段。
type Stage string

const (
	StageUnauthorized Stage = "unauthorized" // 等待手机上允许 USB 调试
	StageOffline      Stage = "offline"
	StageInstalling   Stage = "installing" // 正在安装手机端
	StageStarting     Stage = "starting"   // 建立隧道并启动 App
	StageReady        Stage = "ready"      // 已启动 App，等待或已经连上
	StageSuppressed   Stage = "suppressed" // 用户已断开，拔线前不再自动连接
	StageError        Stage = "error"
)

// Device 设备状态。
type Device struct {
	Serial    string `json:"serial"`       // adb 序列号；WiFi 通道是 ip:port
	ID        string `json:"id,omitempty"` // 手机硬件序列号（ro.serialno），USB 和 WiFi 通道相同；会话的 serial 是它
	Transport string `json:"transport"`    // usb / wifi
	Model     string `json:"model"`
	State     string `json:"state"` // adb 原始状态：device / unauthorized / offline
	Stage     Stage  `json:"stage"`
	Message   string `json:"message,omitempty"`

	setupRunning bool
	lastReverse  time.Time
}

// TokenIssuer 由服务端令牌库实现。
type TokenIssuer interface {
	Issue(serial string) string
	Revoke(serial string)
}

// Config 管理器配置。
type Config struct {
	ADBPath  string // adb 可执行文件
	APKPath  string // 内置手机端安装包，可为空
	Package  string // 手机端包名
	Port     int    // 隧道端口
	HostName string // 显示在手机上的电脑名
	PCID     string // 电脑标识，随 Deep Link 告诉手机（手机用它关联设备记录）
}

// Manager 设备管理器。
type Manager struct {
	cfg    Config
	tokens TokenIssuer
	apk    apkCache // 内置安装包的哈希（判断手机端是否需要更新）

	mu        sync.Mutex
	devices   map[string]*Device
	available bool
	lastErr   string

	OnGone   func(id string) // 手机断开（所有通道都断了）
	OnChange func()

	phones map[string]*phone // 已下发令牌的手机（ro.serialno → 令牌等）

	// 只在轮询协程中访问
	failCount   int       // 连续获取设备列表失败的次数
	lastRestart time.Time // 上次重启 adb 服务的时间
}

// restartServer 重启卡死的 adb 后台服务。kill-server 本身也可能无响应，此时直接结束 adb 进程。
func (m *Manager) restartServer(ctx context.Context) {
	m.lastRestart = time.Now()
	log.Printf("adb 服务无响应，正在重启")
	if _, err := m.run(ctx, 5*time.Second, "kill-server"); err != nil {
		var kill *exec.Cmd
		if runtime.GOOS == "windows" {
			kill = exec.CommandContext(ctx, "taskkill", "/F", "/IM", "adb.exe")
		} else {
			kill = exec.CommandContext(ctx, "pkill", "-x", "adb")
		}
		procutil.Prepare(kill)
		_ = kill.Run()
	}
	time.Sleep(time.Second)
	if _, err := m.run(ctx, 15*time.Second, "start-server"); err != nil {
		log.Printf("adb 重启失败：%v", err)
		return
	}
	log.Printf("adb 服务已重启")
}

func New(cfg Config, tokens TokenIssuer) *Manager {
	m := &Manager{
		cfg: cfg, tokens: tokens, devices: map[string]*Device{},
		phones: map[string]*phone{},
	}
	return m
}

// Available adb 是否可用。
func (m *Manager) Available() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.available
}

// Snapshot 设备列表（用于状态接口）。
func (m *Manager) Snapshot() any {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]Device, 0, len(m.devices))
	for _, d := range m.devices {
		out = append(out, *d)
	}
	return out
}

// SuppressAll 用户点「断开」后，已连接设备在拔线前不再自动连接。
func (m *Manager) SuppressAll() {
	m.mu.Lock()
	for _, d := range m.devices {
		d.Stage = StageSuppressed
		d.Message = "已断开，重新插拔数据线可再次连接"
	}
	m.phones = map[string]*phone{}
	m.mu.Unlock()
	m.changed()
}

func (m *Manager) changed() {
	if m.OnChange != nil {
		m.OnChange()
	}
}

// run 执行 adb 命令，返回合并后的输出。
func (m *Manager) run(ctx context.Context, timeout time.Duration, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, m.cfg.ADBPath, args...)
	procutil.Prepare(cmd)
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	err := cmd.Run()
	s := strings.TrimSpace(out.String())
	if ctx.Err() == context.DeadlineExceeded {
		return s, fmt.Errorf("adb %s 超时", strings.Join(args, " "))
	}
	if err != nil {
		return s, fmt.Errorf("adb %s 失败：%v %s", strings.Join(args, " "), err, s)
	}
	return s, nil
}

// Run 轮询设备，直到 ctx 结束。
func (m *Manager) Run(ctx context.Context) {
	if _, err := m.run(ctx, 15*time.Second, "start-server"); err != nil {
		log.Printf("adb 启动失败：%v", err)
	}
	t := time.NewTicker(time.Second)
	defer t.Stop()
	for {
		m.poll(ctx)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

type listed struct{ serial, state, model string }

func parseDevices(out string) []listed {
	var res []listed
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "List of devices") || strings.HasPrefix(line, "*") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		l := listed{serial: fields[0], state: fields[1]}
		for _, f := range fields[2:] {
			if v, ok := strings.CutPrefix(f, "model:"); ok {
				l.model = strings.ReplaceAll(v, "_", " ")
			}
		}
		res = append(res, l)
	}
	return res
}

func (m *Manager) poll(ctx context.Context) {
	out, err := m.run(ctx, 5*time.Second, "devices", "-l")
	m.mu.Lock()
	wasAvailable := m.available
	m.available = err == nil
	if err != nil && err.Error() != m.lastErr {
		log.Printf("无法获取设备列表：%v", err)
		m.lastErr = err.Error()
	}
	if err == nil {
		m.lastErr = ""
	}
	m.mu.Unlock()
	if err != nil {
		if wasAvailable {
			m.changed()
		}
		m.failCount++
		// adb 后台服务偶尔会卡死（端口能连上但立即断开，或一直无响应），连续失败就重启它
		if m.failCount >= 3 && time.Since(m.lastRestart) > 30*time.Second {
			m.restartServer(ctx)
		}
		return
	}
	m.failCount = 0

	seen := map[string]bool{}
	changed := !wasAvailable
	for _, l := range parseDevices(out) {
		seen[l.serial] = true
		m.mu.Lock()
		d, ok := m.devices[l.serial]
		if !ok {
			d = &Device{Serial: l.serial, Model: l.model, Transport: transportOf(l.serial)}
			m.devices[l.serial] = d
			log.Printf("发现设备 %s（%s，状态 %s）", l.serial, l.model, l.state)
			changed = true
		}
		if d.State != l.state {
			d.State = l.state
			changed = true
		}
		startSetup := false
		switch l.state {
		case "device":
			if d.Stage == "" || d.Stage == StageUnauthorized || d.Stage == StageOffline {
				d.Stage = StageStarting
				d.Message = ""
				startSetup = !d.setupRunning
				d.setupRunning = d.setupRunning || startSetup
			} else if d.Stage == StageReady && time.Since(d.lastReverse) > 5*time.Second {
				d.lastReverse = time.Now()
				go m.ensureReverse(ctx, d.Serial)
			}
		case "unauthorized":
			if d.Stage != StageUnauthorized {
				d.Stage = StageUnauthorized
				d.Message = "请在手机上点「允许 USB 调试」"
				changed = true
			}
		default:
			if d.Stage != StageOffline && d.Stage != StageSuppressed {
				d.Stage = StageOffline
				d.Message = "设备离线，请重新插拔数据线"
				changed = true
			}
		}
		m.mu.Unlock()
		if startSetup {
			changed = true
			go m.setup(ctx, l.serial)
		}
	}

	m.mu.Lock()
	for serial, d := range m.devices {
		if seen[serial] {
			continue
		}
		delete(m.devices, serial)
		if d.Transport == TransportWiFi {
			log.Printf("设备 %s 的 WiFi 通道已断开", serial)
		} else {
			log.Printf("设备 %s 已拔出", serial)
		}
		changed = true
	}
	m.mu.Unlock()
	// 令牌按手机管理：所有通道都断了才作废
	if m.checkPhones(ctx) {
		changed = true
	}
	if changed {
		m.changed()
	}
}

func (m *Manager) setStage(serial string, st Stage, msg string) {
	m.mu.Lock()
	if d, ok := m.devices[serial]; ok && d.Stage != StageSuppressed {
		d.Stage = st
		d.Message = msg
	}
	m.mu.Unlock()
	m.changed()
}

func (m *Manager) suppressed(serial string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	d, ok := m.devices[serial]
	return !ok || d.Stage == StageSuppressed
}

// setup 全自动连接一台设备：装 App → 建隧道 → 下发令牌并启动。
func (m *Manager) setup(ctx context.Context, serial string) {
	defer func() {
		m.mu.Lock()
		if d, ok := m.devices[serial]; ok {
			d.setupRunning = false
		}
		m.mu.Unlock()
	}()
	fail := func(msg string, err error) {
		log.Printf("设备 %s：%s：%v", serial, msg, err)
		m.setStage(serial, StageError, msg)
	}

	// 识别是哪台手机：USB 和 WiFi 两条通道的 ro.serialno 相同
	id := m.phoneID(ctx, serial)
	transport := transportOf(serial)
	m.mu.Lock()
	var other *Device // 同一台手机已经在线的另一条通道
	if d, ok := m.devices[serial]; ok {
		d.ID = id
		for _, o := range m.devices {
			if o != d && o.ID == id && o.State == "device" {
				other = o
			}
		}
	}
	m.mu.Unlock()
	if transport == TransportWiFi {
		if other != nil && other.Transport == TransportUSB {
			log.Printf("设备 %s 已通过数据线连接，断开 WiFi 通道 %s", id, serial)
			_, _ = m.run(ctx, 5*time.Second, "disconnect", serial)
			return
		}
	}

	// 补全型号名（优先用厂商营销名，如「小米 14」）
	name := m.deviceName(ctx, serial)
	if name != "" {
		m.mu.Lock()
		if d, ok := m.devices[serial]; ok {
			d.Model = name
		}
		m.mu.Unlock()
	}

	// 1. 检查并安装手机端；已安装但和内置安装包不同时覆盖更新
	reinstalled := false
	out, err := m.run(ctx, 15*time.Second, "-s", serial, "shell", "pm", "path", m.cfg.Package)
	if err == nil && strings.Contains(out, "package:") {
		if m.needsUpdate(ctx, serial, out) {
			reinstalled = m.updateApp(ctx, serial)
		}
	} else {
		if m.cfg.APKPath == "" || !fileExists(m.cfg.APKPath) {
			m.setStage(serial, StageError, "手机上没有安装 App，电脑端也没有找到内置安装包")
			return
		}
		m.setStage(serial, StageInstalling, "正在安装手机端，部分手机需要在手机上点「允许安装」")
		log.Printf("设备 %s：正在安装 %s", serial, m.cfg.APKPath)
		if out, err := m.run(ctx, 3*time.Minute, "-s", serial, "install", "-r", m.cfg.APKPath); err != nil || !strings.Contains(out, "Success") {
			if err == nil {
				err = fmt.Errorf("%s", out)
			}
			fail("安装手机端失败，请在手机设置里打开「USB 安装」后重新插拔", err)
			return
		}
		reinstalled = true
	}
	if m.suppressed(serial) {
		return
	}

	// 2. 建立隧道（同一端口的隧道会改绑到这条通道上）
	readyMsg := ""
	if transport == TransportWiFi {
		readyMsg = "通过 WiFi 连接"
	}
	m.setStage(serial, StageStarting, readyMsg)
	if err := m.reverse(ctx, serial); err != nil {
		fail("建立隧道失败", err)
		return
	}
	markReady := func() {
		m.mu.Lock()
		if d, ok := m.devices[serial]; ok {
			d.lastReverse = time.Now()
		}
		m.mu.Unlock()
		m.setStage(serial, StageReady, readyMsg)
	}

	// 3a. 这台手机的令牌还有效（刚从另一条通道切过来）：不用重新拉起 App，手机端会用原令牌自动重连
	m.mu.Lock()
	ph, hasToken := m.phones[id]
	token := ""
	if hasToken {
		token = ph.token
		ph.lostAt = time.Time{}
	}
	m.mu.Unlock()
	// 刚装 / 更新过 App 时它已被系统结束，不能等它自动重连，要重新拉起
	if hasToken && !reinstalled {
		if other != nil && other.Transport == TransportWiFi {
			// 数据线插回来了：USB 优先，断开 WiFi 通道，手机端会经 USB 重连
			log.Printf("设备 %s：数据线已插回，切回 USB", id)
			_, _ = m.run(ctx, 5*time.Second, "disconnect", other.Serial)
		} else {
			log.Printf("设备 %s：已切换到 %s 通道，等待手机端重连", id, transport)
		}
		markReady()
		return
	}

	// 3b. 生成令牌，通过显式 Deep Link 启动 App（只有本 App 能收到）
	token = m.tokens.Issue(id)
	m.mu.Lock()
	m.phones[id] = &phone{token: token}
	m.mu.Unlock()
	if err := m.launchApp(ctx, serial, token); err != nil {
		fail("启动手机端失败", err)
		return
	}
	markReady()
	log.Printf("设备 %s：已启动手机端，等待连接", serial)
}

// launchApp 通过显式 Deep Link 把令牌交给 App 并启动它。
func (m *Manager) launchApp(ctx context.Context, serial, token string) error {
	q := url.Values{}
	q.Set("token", token)
	q.Set("host", m.cfg.HostName)
	q.Set("os", runtime.GOOS)
	q.Set("port", fmt.Sprint(m.cfg.Port))
	if m.cfg.PCID != "" {
		q.Set("pcid", m.cfg.PCID)
	}
	link := "p2d://connect?" + q.Encode()
	// adb shell 会把参数拼接后交给手机上的 sh 执行，因此用单引号包住链接（url 编码后不含单引号）
	_, err := m.run(ctx, 15*time.Second, "-s", serial, "shell",
		"am", "start", "-a", "android.intent.action.VIEW", "-d", "'"+link+"'", m.cfg.Package)
	return err
}

// phoneID 手机的硬件序列号；取不到就用 adb 序列号。
func (m *Manager) phoneID(ctx context.Context, serial string) string {
	out, err := m.run(ctx, 5*time.Second, "-s", serial, "shell", "getprop", "ro.serialno")
	if id := strings.TrimSpace(out); err == nil && id != "" && !strings.ContainsAny(id, " :") {
		return id
	}
	return serial
}

func (m *Manager) reverse(ctx context.Context, serial string) error {
	spec := fmt.Sprintf("tcp:%d", m.cfg.Port)
	_, err := m.run(ctx, 10*time.Second, "-s", serial, "reverse", spec, spec)
	return err
}

// ensureReverse adb 服务重启等情况下隧道会丢失，定期检查并补上。
func (m *Manager) ensureReverse(ctx context.Context, serial string) {
	out, err := m.run(ctx, 5*time.Second, "-s", serial, "reverse", "--list")
	if err != nil {
		return
	}
	if !strings.Contains(out, fmt.Sprintf("tcp:%d", m.cfg.Port)) {
		log.Printf("设备 %s：隧道丢失，重新建立", serial)
		_ = m.reverse(ctx, serial)
	}
}

// RemoveReverses 退出时清理所有隧道。
func (m *Manager) RemoveReverses() {
	m.mu.Lock()
	var serials []string
	for s, d := range m.devices {
		if d.State == "device" {
			serials = append(serials, s)
		}
	}
	m.mu.Unlock()
	for _, s := range serials {
		_, _ = m.run(context.Background(), 3*time.Second, "-s", s, "reverse", "--remove", fmt.Sprintf("tcp:%d", m.cfg.Port))
	}
}

func (m *Manager) deviceName(ctx context.Context, serial string) string {
	for _, prop := range []string{"ro.product.marketname", "ro.vendor.oplus.market.name", "ro.config.marketing_name", "ro.product.model"} {
		out, err := m.run(ctx, 5*time.Second, "-s", serial, "shell", "getprop", prop)
		if err == nil && strings.TrimSpace(out) != "" {
			return strings.TrimSpace(out)
		}
	}
	return ""
}

func fileExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && !st.IsDir()
}
