package aoa

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net"
	"sync"
	"testing"
	"time"
)

// pipeTransport 测试用的配件：手机模拟器和链路之间的两条通道
type pipeTransport struct {
	toPC    chan []byte
	toPhone chan []byte
	closed  chan struct{}
	once    sync.Once

	mu     sync.Mutex
	writes []int // 每次写入的长度
}

func newPipe() *pipeTransport {
	return &pipeTransport{toPC: make(chan []byte, 64), toPhone: make(chan []byte, 64), closed: make(chan struct{})}
}

func (p *pipeTransport) Read(b []byte) (int, error) {
	select {
	case c := <-p.toPC:
		if len(c) > len(b) {
			panic("一次传输超过了读缓冲")
		}
		return copy(b, c), nil
	case <-time.After(30 * time.Millisecond):
		return 0, errTimeout
	case <-p.closed:
		return 0, io.EOF
	}
}

func (p *pipeTransport) Write(b []byte) error {
	p.mu.Lock()
	p.writes = append(p.writes, len(b))
	p.mu.Unlock()
	select {
	case p.toPhone <- append([]byte(nil), b...):
		return nil
	case <-p.closed:
		return io.EOF
	}
}

func (p *pipeTransport) Close() error {
	p.once.Do(func() { close(p.closed) })
	return nil
}

// phoneSim 手机端模拟器
type phoneSim struct {
	t   *testing.T
	p   *pipeTransport
	dec decoder
	got []frame
}

func (s *phoneSim) send(typ byte, id uint32, payload []byte) {
	s.p.toPC <- encodeFrame(typ, id, payload)
}

// next 等下一帧（跳过心跳回复）
func (s *phoneSim) next(timeout time.Duration) frame {
	s.t.Helper()
	deadline := time.After(timeout)
	for {
		for len(s.got) > 0 {
			f := s.got[0]
			s.got = s.got[1:]
			if f.typ != tPong {
				return f
			}
		}
		select {
		case c := <-s.p.toPhone:
			frames, bad := s.dec.feed(c)
			if bad {
				s.t.Fatal("手机收到格式不对的数据")
			}
			s.got = append(s.got, frames...)
		case <-deadline:
			s.t.Fatal("等不到电脑发来的帧")
		}
	}
}

func (s *phoneSim) expect(typ byte, timeout time.Duration) frame {
	s.t.Helper()
	f := s.next(timeout)
	if f.typ != typ {
		s.t.Fatalf("收到类型 %d，期望 %d（%q）", f.typ, typ, f.payload)
	}
	return f
}

// echoServer 本机服务的替身：原样返回收到的数据
func echoServer(t *testing.T) (addr string, conns *int32Counter) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	c := &int32Counter{}
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			c.add()
			go func() { _, _ = io.Copy(conn, conn); conn.Close() }()
		}
	}()
	return ln.Addr().String(), c
}

type int32Counter struct {
	mu sync.Mutex
	n  int
}

func (c *int32Counter) add() { c.mu.Lock(); c.n++; c.mu.Unlock() }
func (c *int32Counter) get() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.n
}

func startLink(t *testing.T, addr string, allow func() bool) (*link, *phoneSim, context.CancelFunc) {
	p := newPipe()
	l := newLink(p, linkHooks{
		dial: func() (net.Conn, error) { return net.Dial("tcp", addr) },
		config: func(h helloMsg) (configMsg, bool) {
			if allow != nil && !allow() {
				return configMsg{}, false
			}
			return configMsg{Token: "tok-" + h.Nonce, Host: "pc", OS: "linux"}, true
		},
	})
	ctx, cancel := context.WithCancel(context.Background())
	go func() { _ = l.run(ctx) }()
	t.Cleanup(cancel)
	return l, &phoneSim{t: t, p: p}, cancel
}

func hello(nonce string) []byte { return mustJSON(helloMsg{V: 1, Nonce: nonce, Name: "测试手机"}) }

func TestFrameRoundTrip(t *testing.T) {
	var buf []byte
	buf = appendFrame(buf, tData, 7, []byte("abc"))
	buf = appendFrame(buf, tClose, 7, nil)
	var d decoder
	// 拆成两半喂：一帧跨两次读取
	f1, bad := d.feed(buf[:5])
	if bad || len(f1) != 0 {
		t.Fatalf("半帧不应解出：%v %v", f1, bad)
	}
	f2, bad := d.feed(buf[5:])
	if bad || len(f2) != 2 || f2[0].typ != tData || f2[0].id != 7 || string(f2[0].payload) != "abc" || f2[1].typ != tClose {
		t.Fatalf("解码结果不对：%+v %v", f2, bad)
	}
	if _, bad := d.feed([]byte{1, 2, 3, 4, 5, 6, 7, 8}); !bad {
		t.Fatal("magic 不对应报错")
	}
}

func TestWriteChunksAvoidsPacketMultiples(t *testing.T) {
	for _, n := range []int{1, 511, 512, 1024, 14848, 15000, 15360, 40000} {
		p := newPipe()
		go func() {
			for range p.toPhone {
			}
		}()
		if err := writeChunks(p, make([]byte, n)); err != nil {
			t.Fatal(err)
		}
		total := 0
		for _, w := range p.writes {
			if w%usbPacket == 0 || w > maxWrite {
				t.Fatalf("长度 %d：有一次写入 %d 字节", n, w)
			}
			total += w
		}
		if total != n {
			t.Fatalf("长度 %d：共写出 %d", n, total)
		}
		p.Close()
		close(p.toPhone)
	}
}

func TestLinkHandshakeAndEcho(t *testing.T) {
	addr, conns := echoServer(t)
	_, ph, _ := startLink(t, addr, nil)

	ph.send(tHello, 0, hello("n1"))
	f := ph.expect(tConfig, time.Second)
	var c configMsg
	if err := json.Unmarshal(f.payload, &c); err != nil || c.Token != "tok-n1" || c.Nonce != "n1" {
		t.Fatalf("连接参数不对：%s", f.payload)
	}
	// 同一 nonce 的心跳只回 pong，不重复发参数
	ph.send(tHello, 0, hello("n1"))

	ph.send(tOpen, 1, nil)
	ph.send(tData, 1, []byte("hello"))
	var echoed []byte
	for len(echoed) < 5 {
		f := ph.next(2 * time.Second)
		switch f.typ {
		case tData:
			echoed = append(echoed, f.payload...)
		case tAck:
		default:
			t.Fatalf("意外的帧 %d", f.typ)
		}
	}
	if string(echoed) != "hello" {
		t.Fatalf("回显 %q", echoed)
	}
	if conns.get() != 1 {
		t.Fatalf("本机服务连接数 %d", conns.get())
	}
	ph.send(tClose, 1, nil)
}

// 大量数据：手机按额度发送，靠 tAck 补充额度；回显的数据完整无误
func TestLinkFlowControl(t *testing.T) {
	addr, _ := echoServer(t)
	_, ph, _ := startLink(t, addr, nil)
	ph.send(tHello, 0, hello("n"))
	ph.expect(tConfig, time.Second)
	ph.send(tOpen, 5, nil)

	data := make([]byte, 1<<20)
	for i := range data {
		data[i] = byte(i * 7)
	}
	sent, win := 0, streamWindow
	var echoed []byte
	pcWin := 0 // 电脑发来、手机还没确认的字节
	deadline := time.Now().Add(10 * time.Second)
	for len(echoed) < len(data) {
		if time.Now().After(deadline) {
			t.Fatalf("超时：已发 %d，已收回 %d", sent, len(echoed))
		}
		for sent < len(data) && win > 0 {
			n := maxPayload
			if n > win {
				n = win
			}
			if n > len(data)-sent {
				n = len(data) - sent
			}
			ph.send(tData, 5, data[sent:sent+n])
			sent += n
			win -= n
		}
		f := ph.next(3 * time.Second)
		switch f.typ {
		case tAck:
			win += int(binary.BigEndian.Uint32(f.payload))
		case tData:
			echoed = append(echoed, f.payload...)
			pcWin += len(f.payload)
			if pcWin > streamWindow {
				t.Fatalf("电脑超额发送：%d", pcWin)
			}
			if pcWin >= ackEvery {
				ph.send(tAck, 5, ackPayload(pcWin))
				pcWin = 0
			}
		default:
			t.Fatalf("意外的帧 %d", f.typ)
		}
	}
	if !bytes.Equal(echoed, data) {
		t.Fatal("回显的数据不一致")
	}
}

// 手机端重开配件（nonce 变了）：旧流作废，重新发参数
func TestLinkNewNonceResets(t *testing.T) {
	addr, _ := echoServer(t)
	l, ph, _ := startLink(t, addr, nil)
	ph.send(tHello, 0, hello("a"))
	ph.expect(tConfig, time.Second)
	ph.send(tOpen, 1, nil)
	time.Sleep(50 * time.Millisecond)
	if l.stream(1) == nil {
		t.Fatal("流没有建立")
	}
	ph.send(tHello, 0, hello("b"))
	f := ph.expect(tConfig, time.Second)
	if !bytes.Contains(f.payload, []byte(`"tok-b"`)) {
		t.Fatalf("参数 %s", f.payload)
	}
	if l.stream(1) != nil {
		t.Fatal("旧流应已关闭")
	}
}

// 用户断开后：只回心跳，打开流被拒绝
func TestLinkSuppressed(t *testing.T) {
	addr, _ := echoServer(t)
	allowed := true
	var mu sync.Mutex
	l, ph, _ := startLink(t, addr, func() bool { mu.Lock(); defer mu.Unlock(); return allowed })
	ph.send(tHello, 0, hello("a"))
	ph.expect(tConfig, time.Second)
	mu.Lock()
	allowed = false
	mu.Unlock()
	l.unconfigure()
	ph.send(tHello, 0, hello("a"))
	ph.send(tOpen, 2, nil)
	if f := ph.expect(tClose, time.Second); f.id != 2 {
		t.Fatalf("流编号 %d", f.id)
	}
}

// 心跳超时：作废所有流，通知管理器
func TestLinkHelloTimeout(t *testing.T) {
	addr, _ := echoServer(t)
	p := newPipe()
	gone := make(chan struct{}, 1)
	var mu sync.Mutex
	now := time.Now()
	l := newLink(p, linkHooks{
		dial:      func() (net.Conn, error) { return net.Dial("tcp", addr) },
		config:    func(helloMsg) (configMsg, bool) { return configMsg{Token: "t"}, true },
		phoneGone: func() { gone <- struct{}{} },
	})
	l.now = func() time.Time { mu.Lock(); defer mu.Unlock(); return now }
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = l.run(ctx) }()
	ph := &phoneSim{t: t, p: p}
	ph.send(tHello, 0, hello("x"))
	ph.expect(tConfig, time.Second)
	mu.Lock()
	now = now.Add(helloTimeout + time.Second)
	mu.Unlock()
	select {
	case <-gone:
	case <-time.After(time.Second):
		t.Fatal("心跳超时没有通知")
	}
	// 手机端再打开：重新发参数
	ph.send(tHello, 0, hello("x"))
	ph.expect(tConfig, time.Second)
}

func TestLinkStopsOnTransportError(t *testing.T) {
	addr, _ := echoServer(t)
	p := newPipe()
	l := newLink(p, linkHooks{dial: func() (net.Conn, error) { return net.Dial("tcp", addr) },
		config: func(helloMsg) (configMsg, bool) { return configMsg{}, true }})
	done := make(chan error, 1)
	go func() { done <- l.run(context.Background()) }()
	p.Close()
	select {
	case err := <-done:
		if !errors.Is(err, io.EOF) {
			t.Fatalf("返回 %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("链路没有结束")
	}
}
