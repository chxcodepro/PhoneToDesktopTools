package adb

import (
	"context"
	"testing"
	"time"
)

func TestTransportOf(t *testing.T) {
	cases := map[string]string{
		"3B1F5JE5MS12F371":    TransportUSB,
		"emulator-5554":       TransportUSB,
		"192.168.31.169:5555": TransportWiFi,
		"[fe80::1]:5555":      TransportWiFi,
		"adb-3B1F5JE5MS12F371-AbCd._adb-tls-connect._tcp": TransportWiFi,
	}
	for serial, want := range cases {
		if got := transportOf(serial); got != want {
			t.Errorf("transportOf(%q) = %q, want %q", serial, got, want)
		}
	}
}

func TestParseWlanIP(t *testing.T) {
	out := `1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN group default qlen 1000
    inet 127.0.0.1/8 scope host lo
       valid_lft forever preferred_lft forever
12: rmnet_data0: <UP,LOWER_UP> mtu 1500 qdisc mq state UNKNOWN group default qlen 1000
    inet 10.12.3.4/30 scope global rmnet_data0
28: wlan0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc htb state UP group default qlen 1024
    inet 192.168.31.169/24 brd 192.168.31.255 scope global dynamic wlan0
       valid_lft 30789sec preferred_lft 30789sec`
	if got := parseWlanIP(out); got != "192.168.31.169" {
		t.Fatalf("got %q", got)
	}
	if got := parseWlanIP("1: lo: <LOOPBACK>\n    inet 127.0.0.1/8 scope host lo\n"); got != "" {
		t.Fatalf("没有 WiFi 时应为空，got %q", got)
	}
}

func TestConnectOK(t *testing.T) {
	ok := []string{"connected to 192.168.31.169:5555", "already connected to 192.168.31.169:5555"}
	bad := []string{
		"failed to connect to '192.168.31.169:5555': Connection refused",
		"cannot connect to 192.168.31.169:5555: 由于连接方在一段时间后没有正确答复",
		"",
	}
	for _, s := range ok {
		if !connectOK(s) {
			t.Errorf("应判定为成功：%q", s)
		}
	}
	for _, s := range bad {
		if connectOK(s) {
			t.Errorf("应判定为失败：%q", s)
		}
	}
}

type fakeTokens struct{ revoked []string }

func (f *fakeTokens) Issue(serial string) string { return "tok-" + serial }
func (f *fakeTokens) Revoke(serial string)       { f.revoked = append(f.revoked, serial) }

func TestCheckPhonesGrace(t *testing.T) {
	ctx := context.Background()
	tk := &fakeTokens{}
	m := New(Config{ADBPath: "adb-not-exist", WiFi: true}, tk)
	var gone []string
	m.OnGone = func(id string) { gone = append(gone, id) }

	// 没有记住 WiFi 地址的手机：拔线立即作废令牌
	m.phones["A"] = &phone{token: "ta"}
	m.checkPhones(ctx)
	if len(gone) != 1 || gone[0] != "A" || len(tk.revoked) != 1 {
		t.Fatalf("没有 WiFi 的手机应立即断开：gone=%v revoked=%v", gone, tk.revoked)
	}

	// 记住了 WiFi 地址：先保留令牌等 WiFi 接上
	m.phones["B"] = &phone{token: "tb"}
	m.peers["B"] = &peer{ID: "B", Addr: "192.168.1.2:5555", holdUntil: time.Now().Add(time.Hour)}
	m.checkPhones(ctx)
	if len(gone) != 1 {
		t.Fatalf("宽限期内不应断开：%v", gone)
	}
	// WiFi 通道接上（setup 后 ID 已识别）：恢复在线
	m.devices["192.168.1.2:5555"] = &Device{Serial: "192.168.1.2:5555", ID: "B", State: "device", Transport: TransportWiFi}
	m.checkPhones(ctx)
	if !m.phones["B"].lostAt.IsZero() {
		t.Fatal("通道在线时 lostAt 应清零")
	}
	// WiFi 也断了且超过宽限期：作废
	delete(m.devices, "192.168.1.2:5555")
	m.checkPhones(ctx)
	m.phones["B"].lostAt = time.Now().Add(-wifiGrace - time.Second)
	m.checkPhones(ctx)
	if len(gone) != 2 || gone[1] != "B" {
		t.Fatalf("超过宽限期应断开：%v", gone)
	}

	// 用户点了断开：不等 WiFi
	m.phones["C"] = &phone{token: "tc"}
	m.peers["C"] = &peer{ID: "C", Addr: "192.168.1.3:5555", holdUntil: time.Now().Add(time.Hour)}
	m.SuppressAll()
	if len(m.phones) != 0 {
		t.Fatal("断开后不应再保留令牌")
	}
	if !m.peers["C"].suppressed {
		t.Fatal("断开后不应再自动 WiFi 连接")
	}
}

func TestPeersPersist(t *testing.T) {
	dir := t.TempDir()
	m := New(Config{ADBPath: "adb-not-exist", WiFi: true, StateDir: dir}, &fakeTokens{})
	m.rememberPeer("P1", "192.168.1.5:5555", "OnePlus")
	// 同一地址被分配给另一台手机：旧记录作废
	m.rememberPeer("P2", "192.168.1.5:5555", "Xiaomi")
	m2 := New(Config{ADBPath: "adb-not-exist", WiFi: true, StateDir: dir}, &fakeTokens{})
	if len(m2.peers) != 1 || m2.peers["P2"] == nil || m2.peers["P2"].Model != "Xiaomi" {
		t.Fatalf("重启后应恢复记住的手机：%+v", m2.peers)
	}
}
