// Package adb 自动发现开了 USB 调试的安卓手机：自动安装 App、建立 adb reverse 隧道、通过 Deep Link 下发令牌并启动 App。
// 电脑端自己经 USB 和手机的 adbd 通信（usb.go、internal/adbwire），不再带 adb 程序；
// 电脑上已有 adb 后台服务（Android Studio 等）占着手机时，经它的 5037 端口办事。
// 令牌和会话按手机（ro.serialno）而不是按通道区分，见 phones.go。WiFi 连接改由局域网直连（internal/lan）完成。
package adb

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/url"
	"os"
	"runtime"
	"strings"
	"sync"
	"time"

	"p2d/core/internal/adbwire"
	"p2d/core/internal/usbio"
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
	Serial    string `json:"serial"`       // USB 序列号（和 adb devices 相同）；经 adb 服务的 WiFi 通道是 ip:port
	ID        string `json:"id,omitempty"` // 手机硬件序列号（ro.serialno），USB 和 WiFi 通道相同；会话的 serial 是它
	Transport string `json:"transport"`    // usb / wifi
	Model     string `json:"model"`
	State     string `json:"state"` // device / unauthorized / offline（和 adb devices 相同），error
	Stage     Stage  `json:"stage"`
	Message   string `json:"message,omitempty"`

	setupRunning bool
	lastReverse  time.Time
	link         adbwire.Opener // 执行命令用：USB 直连，或经 adb 服务
	listError    bool           // 错误来自连接本身（接口被占用、没有权限），连上后重新开始
}

// TokenIssuer 由服务端令牌库实现。
type TokenIssuer interface {
	Issue(serial string) string
	Revoke(serial string)
}

// Config 管理器配置。
type Config struct {
	APKPath  string // 内置手机端安装包，可为空
	Package  string // 手机端包名
	Port     int    // 隧道端口
	HostName string // 显示在手机上的电脑名
	PCID     string // 电脑标识，随 Deep Link 告诉手机（手机用它关联设备记录）
	StateDir string // 电脑端数据目录：用户目录下的 .android 写不进去时，ADB 密钥放这里
}

// Manager 设备管理器。
type Manager struct {
	cfg      Config
	tokens   TokenIssuer
	keys     *adbwire.Keys
	apk      apkCache // 内置安装包的哈希（判断手机端是否需要更新）
	rejected rejectedUpdates

	mu        sync.Mutex
	devices   map[string]*Device
	available bool
	lastErr   string

	OnGone   func(id string) // 手机断开（所有通道都断了）
	OnChange func()

	phones map[string]*phone    // 已下发令牌的手机（ro.serialno → 令牌等）
	usb    map[string]*usbPhone // USB 直连的手机（按 usbio.ADBDevice.Key）

	serverSeen bool // 上次轮询时有 adb 后台服务在运行（只在轮询协程里用，用于日志）
}

func New(cfg Config, tokens TokenIssuer) *Manager {
	name := cfg.HostName
	if name == "" {
		name, _ = os.Hostname()
	}
	return &Manager{
		cfg: cfg, tokens: tokens, devices: map[string]*Device{},
		phones: map[string]*phone{}, usb: map[string]*usbPhone{},
		keys:      adbwire.NewKeys(cfg.StateDir, name),
		available: usbio.Supported,
	}
}

// Available 能不能连接开了 USB 调试的手机。
func (m *Manager) Available() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.available
}

// Problem 不能连接的原因（能连接时为空）
func (m *Manager) Problem() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.available {
		return ""
	}
	return m.lastErr
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

// linkOf 设备的命令通道
func (m *Manager) linkOf(serial string) (adbwire.Opener, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if d, ok := m.devices[serial]; ok && d.link != nil {
		return d.link, nil
	}
	return nil, errors.New("设备已断开")
}

// shell 在手机上执行命令，返回输出
func (m *Manager) shell(ctx context.Context, timeout time.Duration, serial, cmd string) (string, error) {
	l, err := m.linkOf(serial)
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	out, err := adbwire.Shell(ctx, l, cmd)
	if err != nil && ctx.Err() == context.DeadlineExceeded {
		return out, fmt.Errorf("执行 %s 超时", cmd)
	}
	return out, err
}

// install 安装内置的手机端安装包，返回手机的输出（成功时含 Success）
func (m *Manager) install(ctx context.Context, serial string) (string, error) {
	l, err := m.linkOf(serial)
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()
	return adbwire.Install(ctx, l, m.cfg.APKPath)
}

// Run 轮询设备，直到 ctx 结束。
func (m *Manager) Run(ctx context.Context) {
	if !usbio.Supported {
		m.mu.Lock()
		m.lastErr = "这个系统不支持数据线连接"
		m.mu.Unlock()
		return
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

type listed struct {
	serial, state, model, msg string
	link                      adbwire.Opener
}

// listDevices 当前的设备：USB 直连的，加上 adb 后台服务管着的（同一台手机直连上了就不经服务）
func (m *Manager) listDevices(ctx context.Context) []listed {
	devs, err := usbio.ADBDevices()
	m.mu.Lock()
	if err != nil {
		if err.Error() != m.lastErr {
			log.Printf("读取 USB 设备失败：%v", err)
		}
		m.lastErr = err.Error()
	} else {
		m.lastErr = ""
		m.syncUSB(ctx, devs)
	}
	direct := map[string]listed{} // 直连的（连着、正在连）
	failed := map[string]listed{} // 打不开的：被占用、驱动不是 WinUSB 等，adb 服务管着它时改经服务
	for _, p := range m.usb {
		l := listed{serial: p.serial, state: p.state, model: p.model, msg: p.msg}
		if p.conn != nil {
			l.link = p.conn
		}
		if p.conn == nil && (p.state == stBusy || p.state == stError) {
			if p.state == stBusy {
				l.state = stError
			}
			failed[p.serial] = l
		} else {
			direct[p.serial] = l
		}
	}
	m.mu.Unlock()

	srv, err := adbwire.ServerDevices(ctx)
	if running := err == nil; running != m.serverSeen {
		m.serverSeen = running
		if running {
			log.Printf("电脑上有 adb 后台服务在运行，它占着的手机经它连接")
		}
	}
	return mergeDevices(direct, failed, srv)
}

// mergeDevices 合并直连的和 adb 服务列出的设备：同一台手机直连上了就不经服务；直连打不开、服务管着它时改经服务
func mergeDevices(direct, failed map[string]listed, srv []adbwire.ServerDevice) []listed {
	var res []listed
	for _, d := range srv {
		if _, ok := direct[d.Serial]; ok {
			continue
		}
		delete(failed, d.Serial)
		res = append(res, listed{serial: d.Serial, state: d.State, model: d.Model, link: adbwire.Server{Serial: d.Serial}})
	}
	for _, l := range direct {
		res = append(res, l)
	}
	for _, l := range failed {
		res = append(res, l)
	}
	return res
}

func (m *Manager) poll(ctx context.Context) {
	seen := map[string]bool{}
	changed := false
	for _, l := range m.listDevices(ctx) {
		seen[l.serial] = true
		m.mu.Lock()
		d, ok := m.devices[l.serial]
		if !ok {
			d = &Device{Serial: l.serial, Model: l.model, Transport: transportOf(l.serial)}
			m.devices[l.serial] = d
			if l.model != "" {
				log.Printf("发现设备 %s（%s）", l.serial, l.model)
			} else {
				log.Printf("发现设备 %s", l.serial)
			}
			changed = true
		}
		if d.State != l.state {
			d.State = l.state
			changed = true
		}
		d.link = l.link
		if d.Model == "" && l.model != "" {
			d.Model = l.model
			changed = true
		}
		startSetup := false
		switch l.state {
		case stDevice:
			if d.Stage == "" || d.Stage == StageUnauthorized || d.Stage == StageOffline || (d.Stage == StageError && d.listError) {
				d.Stage = StageStarting
				d.Message = ""
				d.listError = false
				startSetup = !d.setupRunning
				d.setupRunning = d.setupRunning || startSetup
			} else if d.Stage == StageReady && time.Since(d.lastReverse) > 5*time.Second {
				d.lastReverse = time.Now()
				go m.ensureReverse(ctx, d.Serial)
			}
		case stUnauthorized:
			if d.Stage != StageUnauthorized {
				d.Stage = StageUnauthorized
				d.Message = "请在手机上点「允许 USB 调试」"
				changed = true
			}
		case stConnecting:
			// 正在握手（一般几毫秒），界面保持原样
		case stError:
			if d.Stage != StageSuppressed && (d.Stage != StageError || d.Message != l.msg) {
				d.Stage = StageError
				d.Message = l.msg
				d.listError = true
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
			if o != d && o.ID == id && o.State == stDevice {
				other = o
			}
		}
	}
	m.mu.Unlock()
	if transport == TransportWiFi {
		if other != nil && other.Transport == TransportUSB {
			log.Printf("设备 %s 已通过数据线连接，断开 WiFi 通道 %s", id, serial)
			_ = adbwire.ServerDisconnect(ctx, serial)
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
	out, err := m.shell(ctx, 15*time.Second, serial, "pm path "+m.cfg.Package)
	if err == nil && strings.Contains(out, "package:") {
		if update, key := m.needsUpdate(ctx, serial, out); update {
			reinstalled = m.updateApp(ctx, serial, key)
		}
	} else {
		if m.cfg.APKPath == "" || !fileExists(m.cfg.APKPath) {
			m.setStage(serial, StageError, "手机上没有安装 App，电脑端也没有找到内置安装包")
			return
		}
		m.setStage(serial, StageInstalling, "正在安装手机端，部分手机需要在手机上点「允许安装」")
		log.Printf("设备 %s：正在安装 %s", serial, m.cfg.APKPath)
		if out, err := m.install(ctx, serial); err != nil || !strings.Contains(out, "Success") {
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
			_ = adbwire.ServerDisconnect(ctx, other.Serial)
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
	go m.relaunchIfUnused(ctx, serial, id, token)
}

// relaunchIfUnused 拉起手机端后 8 秒还没用新令牌连上就再拉起一次（最多两次）。
// 刚装 / 更新过的 App 第一次被拉起时，偶尔没收到链接里的新令牌，用旧令牌连接被拒绝后就停在「令牌无效」。
func (m *Manager) relaunchIfUnused(ctx context.Context, serial, id, token string) {
	u, ok := m.tokens.(interface{ Used(token string) bool })
	if !ok {
		return
	}
	for i := 0; i < 2; i++ {
		select {
		case <-ctx.Done():
			return
		case <-time.After(8 * time.Second):
		}
		if u.Used(token) {
			return
		}
		m.mu.Lock()
		ph, okp := m.phones[id]
		d, okd := m.devices[serial]
		still := okp && ph.token == token && okd && d.State == stDevice
		m.mu.Unlock()
		if !still {
			return
		}
		log.Printf("设备 %s：手机端没有用新令牌连上，重新拉起", serial)
		if err := m.launchApp(ctx, serial, token); err != nil {
			return
		}
	}
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
	// 命令交给手机上的 sh 执行，因此用单引号包住链接（url 编码后不含单引号）
	out, err := m.shell(ctx, 15*time.Second, serial, "am start -a android.intent.action.VIEW -d '"+link+"' "+m.cfg.Package)
	if err == nil && strings.Contains(out, "Error:") {
		err = errors.New(out)
	}
	return err
}

// phoneID 手机的硬件序列号；取不到就用连接的序列号。
func (m *Manager) phoneID(ctx context.Context, serial string) string {
	out, err := m.shell(ctx, 5*time.Second, serial, "getprop ro.serialno")
	if id := strings.TrimSpace(out); err == nil && id != "" && !strings.ContainsAny(id, " :") {
		return id
	}
	return serial
}

func (m *Manager) reverse(ctx context.Context, serial string) error {
	l, err := m.linkOf(serial)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	return adbwire.Reverse(ctx, l, m.cfg.Port)
}

// ensureReverse 手机重新连接、adb 服务重启等情况下隧道会丢失，定期检查并补上。
func (m *Manager) ensureReverse(ctx context.Context, serial string) {
	l, err := m.linkOf(serial)
	if err != nil {
		return
	}
	lctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	out, err := adbwire.ReverseList(lctx, l)
	cancel()
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
	var links []adbwire.Opener
	for _, d := range m.devices {
		if d.State == stDevice && d.link != nil {
			links = append(links, d.link)
		}
	}
	m.mu.Unlock()
	for _, l := range links {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		_ = adbwire.ReverseRemove(ctx, l, m.cfg.Port)
		cancel()
	}
}

func (m *Manager) deviceName(ctx context.Context, serial string) string {
	for _, prop := range []string{"ro.product.marketname", "ro.vendor.oplus.market.name", "ro.config.marketing_name", "ro.product.model"} {
		out, err := m.shell(ctx, 5*time.Second, serial, "getprop "+prop)
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
