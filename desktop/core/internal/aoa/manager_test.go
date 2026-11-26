package aoa

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"
)

type fakeTokens struct {
	mu      sync.Mutex
	issued  map[string]string
	revoked []string
}

func (f *fakeTokens) Issue(id string) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.issued == nil {
		f.issued = map[string]string{}
	}
	f.issued[id] = "token-" + id
	return f.issued[id]
}

func (f *fakeTokens) Revoke(id string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.revoked = append(f.revoked, id)
}

// fakeUSB 假的 USB：Switch 后把手机换成配件设备
type fakeUSB struct {
	mu       sync.Mutex
	devs     []usbDevice
	probeErr error
	switches int
	pipes    chan *pipeTransport
}

func (f *fakeUSB) List() ([]usbDevice, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]usbDevice(nil), f.devs...), nil
}

func (f *fakeUSB) Probe(d usbDevice) (int, error) {
	if f.probeErr != nil {
		return 0, f.probeErr
	}
	if d.VID == 0x04A9 { // 相机：不支持
		return 0, errors.New("stall")
	}
	return 2, nil
}

func (f *fakeUSB) Switch(d usbDevice, strs [6]string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if strs[0] != accessoryManufacturer || strs[1] != accessoryModel {
		panic("识别字符串不对")
	}
	f.switches++
	for i, x := range f.devs {
		if x.Name == d.Name {
			f.devs[i] = accessoryDev(d.Name, d.Serial, d.Addr+1)
		}
	}
	return nil
}

func (f *fakeUSB) Open(d usbDevice) (transport, error) {
	p := newPipe()
	f.pipes <- p
	return p, nil
}

func (f *fakeUSB) unplug() {
	f.mu.Lock()
	f.devs = nil
	f.mu.Unlock()
}

func mtpPhone(name, serial string) usbDevice {
	return usbDevice{Name: name, Addr: 5, VID: 0x22D9, PID: 0x2765, Serial: serial, Product: "PJZ110",
		Ifaces: []usbIface{{Num: 0, Class: classStill, SubClass: 1, Protocol: 1}}}
}

func accessoryDev(name, serial string, addr int) usbDevice {
	return usbDevice{Name: name, Addr: addr, VID: googleVID, PID: accessoryPIDMin, Serial: serial, Product: "PJZ110",
		Ifaces: []usbIface{{Num: 0, Class: classVendor, SubClass: 0xFF, EPs: []usbEP{{Addr: 0x81, Bulk: true, In: true}, {Addr: 0x01, Bulk: true}}}}}
}

func stageOf(m *Manager, id string) (string, bool) {
	for _, d := range m.Snapshot() {
		if d.ID == id {
			return d.Stage, true
		}
	}
	return "", false
}

func TestManagerFirstConnectNeedsClick(t *testing.T) {
	usb := &fakeUSB{devs: []usbDevice{mtpPhone("1-2", "ABC123"), {Name: "1-3", VID: 0x04A9, Ifaces: []usbIface{{Class: classStill, SubClass: 1, Protocol: 1}}}}, pipes: make(chan *pipeTransport, 4)}
	tok := &fakeTokens{}
	dir := t.TempDir()
	m := newManager(Config{Port: 1, HostName: "pc", PCID: "abcd1234", StateDir: dir}, tok, usb)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	m.poll(ctx)
	snap := m.Snapshot()
	if len(snap) != 1 || snap[0].ID != "ABC123" || snap[0].Stage != StageAvailable {
		t.Fatalf("应只显示手机、等待点击：%+v", snap)
	}
	m.poll(ctx)
	if usb.switches != 0 {
		t.Fatal("没点「免调试连接」不应切换")
	}

	if err := m.Connect("ABC123"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { usb.mu.Lock(); defer usb.mu.Unlock(); return usb.switches == 1 })
	m.poll(ctx) // 手机变成配件
	p := <-usb.pipes
	if st, _ := stageOf(m, "ABC123"); st != StageStarting {
		t.Fatalf("等手机打开 App：%s", st)
	}

	ph := &phoneSim{t: t, p: p}
	ph.send(tHello, 0, mustJSON(helloMsg{V: 1, Nonce: "n", Name: "OnePlus 13"}))
	f := ph.expect(tConfig, time.Second)
	var c configMsg
	_ = json.Unmarshal(f.payload, &c)
	if c.Token != "token-ABC123" || c.Host != "pc" || c.PCID != "abcd1234" {
		t.Fatalf("参数 %+v", c)
	}
	waitFor(t, func() bool {
		st, _ := stageOf(m, "ABC123")
		return st == StageReady
	})
	if d := m.Snapshot()[0]; d.Model != "OnePlus 13" || d.State != "device" {
		t.Fatalf("设备 %+v", d)
	}

	// 记住了：下次插上自动切换
	m2 := newManager(Config{StateDir: dir}, tok, &fakeUSB{devs: []usbDevice{mtpPhone("1-2", "ABC123")}, pipes: make(chan *pipeTransport, 1)})
	if _, ok := m2.known["ABC123"]; !ok {
		t.Fatal("没有记住这台手机")
	}

	// 拔出：超过 goneAfter 后作废令牌、通知服务端
	old := goneAfter
	goneAfter = 0
	defer func() { goneAfter = old }()
	var goneID string
	m.OnGone = func(id string) { goneID = id }
	usb.unplug()
	m.poll(ctx)
	if goneID != "ABC123" || len(tok.revoked) != 1 {
		t.Fatalf("拔出后应作废令牌：gone=%q revoked=%v", goneID, tok.revoked)
	}
}

func TestManagerRememberedAutoSwitchAndSuppress(t *testing.T) {
	dir := t.TempDir()
	usb := &fakeUSB{devs: []usbDevice{mtpPhone("1-2", "S1")}, pipes: make(chan *pipeTransport, 4)}
	m := newManager(Config{StateDir: dir}, &fakeTokens{}, usb)
	m.known["S1"] = knownPhone{Name: "我的手机"}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	m.poll(ctx)
	waitFor(t, func() bool { usb.mu.Lock(); defer usb.mu.Unlock(); return usb.switches == 1 })
	if d := m.Snapshot()[0]; d.Model != "我的手机" {
		t.Fatalf("应显示记住的名字：%+v", d)
	}
	m.poll(ctx)
	p := <-usb.pipes
	ph := &phoneSim{t: t, p: p}
	ph.send(tHello, 0, hello("n"))
	ph.expect(tConfig, time.Second)

	m.SuppressAll()
	if st, _ := stageOf(m, "S1"); st != StageSuppressed {
		t.Fatalf("断开后：%s", st)
	}
	// 断开后手机端心跳不再拿到参数，打开流被拒绝
	ph.send(tHello, 0, hello("n"))
	ph.send(tOpen, 3, nil)
	ph.expect(tClose, time.Second)
}

func TestManagerSkipsADBPhones(t *testing.T) {
	phone := mtpPhone("1-2", "D1")
	phone.Ifaces = append(phone.Ifaces, usbIface{Num: 1, Class: classVendor, SubClass: 0x42, Protocol: 1})
	usb := &fakeUSB{devs: []usbDevice{phone}, pipes: make(chan *pipeTransport, 1)}
	adbOK := true
	m := newManager(Config{ADBAvailable: func() bool { return adbOK }}, &fakeTokens{}, usb)
	m.poll(context.Background())
	if len(m.Snapshot()) != 0 {
		t.Fatal("开了 USB 调试、有 adb 时应交给 adb")
	}
	// 没有 adb：开了调试的手机也能免调试连接
	adbOK = false
	m.poll(context.Background())
	if len(m.Snapshot()) != 1 {
		t.Fatal("没有 adb 时应显示出来")
	}
}

func TestManagerNoPermission(t *testing.T) {
	usb := &fakeUSB{devs: []usbDevice{mtpPhone("1-2", "P1")}, probeErr: errPermission, pipes: make(chan *pipeTransport, 1)}
	m := newManager(Config{}, &fakeTokens{}, usb)
	m.poll(context.Background())
	snap := m.Snapshot()
	if len(snap) != 1 || snap[0].Message != msgNoPerm {
		t.Fatalf("应提示没有权限：%+v", snap)
	}
	if err := m.Connect("P1"); err == nil {
		t.Fatal("没有权限时点连接应报错")
	}
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatal("等待超时")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// 切换失败或手机一直没变成配件：回到可点击状态，可以再点一次
func TestManagerSwitchTimeout(t *testing.T) {
	usb := &stuckUSB{fakeUSB{devs: []usbDevice{mtpPhone("1-2", "T1")}, pipes: make(chan *pipeTransport, 1)}}
	m := newManager(Config{}, &fakeTokens{}, usb)
	ctx := context.Background()
	m.poll(ctx)
	if err := m.Connect("T1"); err != nil {
		t.Fatal(err)
	}
	if st, _ := stageOf(m, "T1"); st != StageStarting {
		t.Fatalf("点击后：%s", st)
	}
	old := switchTimeout
	switchTimeout = 0
	defer func() { switchTimeout = old }()
	time.Sleep(10 * time.Millisecond)
	m.poll(ctx)
	if d := m.Snapshot()[0]; d.Stage != StageAvailable || d.Message != msgSwitchTimeout {
		t.Fatalf("超时后：%+v", d)
	}
	if err := m.Connect("T1"); err != nil {
		t.Fatal("应能再点一次：", err)
	}
}

// stuckUSB 切换请求发出去了，手机却没有变成配件
type stuckUSB struct{ fakeUSB }

func (s *stuckUSB) Switch(usbDevice, [6]string) error { return nil }
