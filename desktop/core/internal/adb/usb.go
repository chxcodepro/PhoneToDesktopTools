package adb

// 经 USB 直接连接开了 USB 调试的手机（internal/adbwire），不需要 adb 程序。
// 每台插着的手机一个协程：打开 ADB 接口 → 握手（等用户点「允许 USB 调试」）→ 保持连接直到拔线或出错，出错后过一会儿重连。

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"log"
	"time"

	"p2d/core/internal/adbwire"
	"p2d/core/internal/usbio"
)

// 直连的状态（listed.state 的取值，前三个和 adb devices 的一样）
const (
	stDevice       = "device"
	stUnauthorized = "unauthorized"
	stOffline      = "offline"
	stConnecting   = "connecting" // 正在握手，不改变界面上的阶段
	stBusy         = "busy"       // 接口被别的程序占着
	stError        = "error"
)

const (
	msgBusy   = "手机的 USB 调试接口被其他程序占用（如 Android Studio 的 adb），请关闭它后重新插拔数据线"
	msgNoPerm = "没有权限访问这台手机的 USB 设备：请用 deb 安装包重新安装电脑端（会添加 USB 权限规则），然后重新插拔数据线"
)

// usbPhone 一台经 USB 直连的手机
type usbPhone struct {
	dev     usbio.ADBDevice
	serial  string
	state   string
	msg     string
	model   string
	conn    *adbwire.Conn
	cancel  context.CancelFunc
	running bool
	retryAt time.Time
	errText string // 上次记到日志里的错误，相同的不重复记
	fails   int    // 连续握手失败的次数
}

// serialFor 显示用的序列号：USB 序列号（和 adb devices 相同），设备没有序列号时用插口算一个
func serialFor(d usbio.ADBDevice) string {
	if d.Serial != "" {
		return d.Serial
	}
	h := sha256.Sum256([]byte(d.Key))
	return "usb-" + hex.EncodeToString(h[:4])
}

// syncUSB 按当前插着的设备启动或结束连接协程。调用时持有 m.mu。
func (m *Manager) syncUSB(ctx context.Context, devs []usbio.ADBDevice) {
	seen := map[string]bool{}
	for _, d := range devs {
		seen[d.Key] = true
		p := m.usb[d.Key]
		if p == nil {
			p = &usbPhone{dev: d, serial: serialFor(d), state: stConnecting}
			m.usb[d.Key] = p
		}
		if !p.running && time.Now().After(p.retryAt) {
			p.running = true
			cctx, cancel := context.WithCancel(ctx)
			p.cancel = cancel
			go m.connectUSB(cctx, p)
		}
	}
	for key, p := range m.usb {
		if seen[key] {
			continue
		}
		if p.cancel != nil {
			p.cancel()
		}
		if p.conn != nil {
			p.conn.Close()
		}
		delete(m.usb, key)
	}
}

func (m *Manager) setUSB(p *usbPhone, state, msg string) {
	m.mu.Lock()
	p.state, p.msg = state, msg
	m.mu.Unlock()
}

// connectUSB 连接一台手机并保持，直到断开
func (m *Manager) connectUSB(ctx context.Context, p *usbPhone) {
	retry := func(after time.Duration, state, msg string, err error) {
		m.mu.Lock()
		p.running = false
		p.conn = nil
		p.retryAt = time.Now().Add(after)
		p.state, p.msg = state, msg
		logIt := err != nil && err.Error() != p.errText
		if err != nil {
			p.errText = err.Error()
		}
		m.mu.Unlock()
		if logIt && ctx.Err() == nil {
			log.Printf("设备 %s：%v", p.serial, err)
		}
	}
	pipe, err := p.dev.Open()
	switch {
	case errors.Is(err, usbio.ErrBusy):
		retry(3*time.Second, stBusy, msgBusy, err)
		return
	case errors.Is(err, usbio.ErrPermission):
		retry(3*time.Second, stError, msgNoPerm, err)
		return
	case err != nil:
		retry(3*time.Second, stError, "无法打开手机的 USB 调试接口："+err.Error(), err)
		return
	}
	m.setUSB(p, stConnecting, "")
	conn, err := adbwire.Handshake(ctx, pipe, m.keys, func(s adbwire.State) {
		m.setUSB(p, string(s), "")
		m.changed()
	})
	if err != nil {
		// 偶尔失败（手机刚插上、USB 重新枚举）不提示，连续失败才在界面上说明
		m.mu.Lock()
		p.fails++
		fails := p.fails
		m.mu.Unlock()
		if fails >= 3 {
			retry(2*time.Second, stError, "无法和手机建立 USB 调试连接，请重新插拔数据线（"+err.Error()+"）", err)
		} else {
			retry(2*time.Second, stConnecting, "", err)
		}
		return
	}
	m.mu.Lock()
	p.conn, p.model, p.state, p.msg, p.errText, p.fails = conn, conn.Model(), stDevice, "", "", 0
	m.mu.Unlock()
	log.Printf("设备 %s：已通过 USB 直接连接（%s）", p.serial, p.model)
	m.changed()
	select {
	case <-conn.Done():
	case <-ctx.Done():
		conn.Close()
	}
	if ctx.Err() == nil {
		log.Printf("设备 %s：USB 连接断开：%v", p.serial, conn.Err())
	}
	retry(time.Second, stConnecting, "", nil)
}
