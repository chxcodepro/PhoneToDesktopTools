// 令牌按手机（ro.serialno）管理，而不是按 adb 通道：同一台手机的所有通道都断开后才作废。
// （之前的「adb 网络调试 + 自动 WiFi」已由局域网直连取代，见 internal/lan。）
package adb

import (
	"context"
	"log"
	"regexp"
	"strings"
	"time"
)

// Transport 设备通道。
const (
	TransportUSB  = "usb"
	TransportWiFi = "wifi" // 用户手动 adb connect 的网络通道
)

// phone 已下发令牌的手机（按 ro.serialno）。
type phone struct {
	token  string
	lostAt time.Time // 所有通道都断开的时刻；零值表示在线
}

var serialHostPort = regexp.MustCompile(`^[0-9a-fA-F.:\[\]]+:\d+$`)

// transportOf 根据 adb 序列号判断通道类型：ip:port 或无线调试的 mDNS 名称为网络通道。
func transportOf(serial string) string {
	if serialHostPort.MatchString(serial) || strings.Contains(serial, "._adb-tls-connect.") {
		return TransportWiFi
	}
	return TransportUSB
}

// checkPhones 每次轮询后调用：手机的所有通道都断开后作废令牌、断开会话。
func (m *Manager) checkPhones(_ context.Context) bool {
	m.mu.Lock()
	alive := map[string]bool{}
	for _, d := range m.devices {
		if d.State == "device" && d.ID != "" {
			alive[d.ID] = true
		}
	}
	var lost []string
	for id := range m.phones {
		if !alive[id] {
			lost = append(lost, id)
			delete(m.phones, id)
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
	return len(lost) > 0
}
