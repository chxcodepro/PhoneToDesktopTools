package adbwire

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// memPipe 内存里的一对端点，模拟 USB：一次 Write 对方一次 Read 读到
type memPipe struct {
	in, out   chan []byte
	closed    chan struct{}
	closeOnce *sync.Once
}

func newMemPipes() (host, dev *memPipe) {
	a, b := make(chan []byte, 64), make(chan []byte, 64)
	closed := make(chan struct{})
	once := &sync.Once{}
	return &memPipe{in: a, out: b, closed: closed, closeOnce: once}, &memPipe{in: b, out: a, closed: closed, closeOnce: once}
}

func (p *memPipe) Read(b []byte) (int, error) {
	select {
	case d := <-p.in:
		if len(d) > len(b) {
			panic("读缓冲太小")
		}
		return copy(b, d), nil
	case <-p.closed:
		return 0, io.EOF
	}
}

func (p *memPipe) Write(b []byte) error {
	select {
	case p.out <- append([]byte(nil), b...):
		return nil
	case <-p.closed:
		return io.ErrClosedPipe
	}
}

func (p *memPipe) Close() error {
	p.closeOnce.Do(func() { close(p.closed) })
	return nil
}

// fakeDevice 模拟手机的 adbd
type fakeDevice struct {
	t      *testing.T
	p      *memPipe
	parser parser
	queue  []message

	known      []*rsa.PublicKey // 已经允许过的电脑
	acceptKey  bool             // 收到公钥后是否「允许」
	gotKey     chan string
	installed  chan int
	reverseOK  chan string
	openDevice chan string // 测试让手机发起连接（模拟手机上的 App 连 127.0.0.1:端口）
}

func (d *fakeDevice) send(m message) {
	if err := d.p.Write(encodeHeader(m)); err != nil {
		return
	}
	if len(m.data) > 0 {
		_ = d.p.Write(m.data)
	}
}

func (d *fakeDevice) read() (message, bool) {
	buf := make([]byte, 1<<20)
	for len(d.queue) == 0 {
		n, err := d.p.Read(buf)
		if err != nil {
			return message{}, false
		}
		msgs, _ := d.parser.feed(buf[:n])
		d.queue = append(d.queue, msgs...)
	}
	m := d.queue[0]
	d.queue = d.queue[1:]
	return m, true
}

// decodePublicKey 解析 Android 格式的公钥（测试用，和 encodePublicKey 相反）
func decodePublicKey(t *testing.T, s string) *rsa.PublicKey {
	b, err := base64.StdEncoding.DecodeString(strings.Fields(strings.TrimRight(s, "\x00"))[0])
	if err != nil || len(b) != 524 {
		t.Fatalf("公钥格式不对：%v %d", err, len(b))
	}
	words := int(binary.LittleEndian.Uint32(b))
	le := b[8 : 8+words*4]
	be := make([]byte, len(le))
	for i := range le {
		be[i] = le[len(le)-1-i]
	}
	return &rsa.PublicKey{N: new(big.Int).SetBytes(be), E: int(binary.LittleEndian.Uint32(b[8+words*8:]))}
}

func (d *fakeDevice) run() {
	token := make([]byte, 20)
	sendToken := func() {
		_, _ = rand.Read(token)
		d.send(message{cmd: cmdAUTH, arg0: authToken, data: token})
	}
	streams := map[uint32]uint32{} // 手机的流号 → 电脑的流号
	var next uint32 = 100
	var mu sync.Mutex
	installLeft := map[uint32]int{}
	installGot := map[uint32]int{}
	connected := false
	devInit := map[uint32]bool{} // 手机发起的连接
	go func() {
		for dest := range d.openDevice {
			mu.Lock()
			next++
			id := next
			mu.Unlock()
			d.send(message{cmd: cmdOPEN, arg0: id, data: append([]byte(dest), 0)})
		}
	}()
	for {
		m, ok := d.read()
		if !ok {
			return
		}
		switch m.cmd {
		case cmdCNXN:
			sendToken()
		case cmdAUTH:
			switch m.arg0 {
			case authSignature:
				okSig := false
				for _, k := range d.known {
					if rsa.VerifyPKCS1v15(k, crypto.SHA1, token, m.data) == nil {
						okSig = true
					}
				}
				if okSig {
					connected = true
					d.send(message{cmd: cmdCNXN, arg0: version, arg1: 4096, data: []byte("device::ro.product.name=x;ro.product.model=PJZ110;features=cmd\x00")})
				} else {
					sendToken()
				}
			case authRSAPublicKey:
				d.gotKey <- string(m.data)
				if d.acceptKey {
					d.known = append(d.known, decodePublicKey(d.t, string(m.data)))
					connected = true
					d.send(message{cmd: cmdCNXN, arg0: version, arg1: 4096, data: []byte("device::ro.product.model=PJZ110;\x00")})
				}
			}
		case cmdOPEN:
			if !connected {
				continue
			}
			svc := strings.TrimRight(string(m.data), "\x00")
			mu.Lock()
			next++
			id := next
			mu.Unlock()
			streams[id] = m.arg0
			switch {
			case svc == "shell:getprop ro.serialno":
				d.send(message{cmd: cmdOKAY, arg0: id, arg1: m.arg0})
				d.send(message{cmd: cmdWRTE, arg0: id, arg1: m.arg0, data: []byte("3B1F5JE5MS12F371\n")})
				// 等电脑确认后关闭
			case strings.HasPrefix(svc, "exec:cmd package install -r -S "):
				var n int
				fmt.Sscanf(strings.TrimPrefix(svc, "exec:cmd package install -r -S "), "%d", &n)
				installLeft[id] = n
				d.send(message{cmd: cmdOKAY, arg0: id, arg1: m.arg0})
			case strings.HasPrefix(svc, "reverse:forward:"):
				d.reverseOK <- strings.TrimPrefix(svc, "reverse:forward:")
				d.send(message{cmd: cmdOKAY, arg0: id, arg1: m.arg0})
				d.send(message{cmd: cmdWRTE, arg0: id, arg1: m.arg0, data: []byte("OKAYOKAY")})
				d.send(message{cmd: cmdCLSE, arg0: id, arg1: m.arg0})
			default:
				d.send(message{cmd: cmdCLSE, arg1: m.arg0}) // 不支持的服务
			}
		case cmdOKAY:
			if _, ok := streams[m.arg1]; !ok {
				// 手机发起的连接被电脑答应了：发一段数据，等回显
				streams[m.arg1] = m.arg0
				devInit[m.arg1] = true
				d.send(message{cmd: cmdWRTE, arg0: m.arg1, arg1: m.arg0, data: []byte("ping")})
				continue
			}
			if devInit[m.arg1] {
				continue
			}
			if m.arg1 > 100 && installLeft[m.arg1] == 0 && installGot[m.arg1] == 0 {
				// 电脑确认收到了 getprop 的输出：关闭
				d.send(message{cmd: cmdCLSE, arg0: m.arg1, arg1: m.arg0})
			}
		case cmdWRTE:
			id := m.arg1
			if left, ok := installLeft[id]; ok && left > 0 {
				if len(m.data) > 4096 {
					d.t.Errorf("一条消息 %d 字节，超过了手机的上限", len(m.data))
				}
				installLeft[id] -= len(m.data)
				installGot[id] += len(m.data)
				d.send(message{cmd: cmdOKAY, arg0: id, arg1: m.arg0})
				if installLeft[id] == 0 {
					d.installed <- installGot[id]
					d.send(message{cmd: cmdWRTE, arg0: id, arg1: m.arg0, data: []byte("Success\n")})
					d.send(message{cmd: cmdCLSE, arg0: id, arg1: m.arg0})
				}
				continue
			}
			// 手机发起的连接收到回显
			d.send(message{cmd: cmdOKAY, arg0: id, arg1: m.arg0})
			d.reverseOK <- "echo:" + string(m.data)
		}
	}
}

func newTestKeys(t *testing.T) *Keys {
	t.Setenv("ANDROID_USER_HOME", filepath.Join(t.TempDir(), "android"))
	return NewKeys(t.TempDir(), "test")
}

func TestHandshakeNewKeyThenShellInstallReverse(t *testing.T) {
	keys := newTestKeys(t)
	host, dev := newMemPipes()
	d := &fakeDevice{t: t, p: dev, acceptKey: true, gotKey: make(chan string, 1), installed: make(chan int, 1),
		reverseOK: make(chan string, 4), openDevice: make(chan string, 1)}
	go d.run()
	defer close(d.openDevice)

	var states []State
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	c, err := Handshake(ctx, host, keys, func(s State) { states = append(states, s) })
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if len(states) != 1 || states[0] != StateUnauthorized {
		t.Fatalf("应先等用户允许：%v", states)
	}
	if !strings.HasSuffix(strings.TrimRight(<-d.gotKey, "\x00"), " P2D@test") {
		t.Fatal("公钥后面应带电脑名")
	}
	if c.Model() != "PJZ110" {
		t.Fatalf("型号 %q", c.Model())
	}
	// 密钥保存下来了
	if _, err := os.Stat(filepath.Join(os.Getenv("ANDROID_USER_HOME"), "adbkey")); err != nil {
		t.Fatal(err)
	}

	out, err := Shell(ctx, c, "getprop ro.serialno")
	if err != nil || out != "3B1F5JE5MS12F371" {
		t.Fatalf("shell：%q %v", out, err)
	}

	apk := filepath.Join(t.TempDir(), "a.apk")
	data := make([]byte, 10000)
	_ = os.WriteFile(apk, data, 0o644)
	out, err = Install(ctx, c, apk)
	if err != nil || out != "Success" {
		t.Fatalf("install：%q %v", out, err)
	}
	if n := <-d.installed; n != len(data) {
		t.Fatalf("手机收到 %d 字节", n)
	}

	// 反向转发：手机连 tcp:端口，转到电脑上的回显服务
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		for {
			s, err := ln.Accept()
			if err != nil {
				return
			}
			go func() { _, _ = io.Copy(s, s) }()
		}
	}()
	port := ln.Addr().(*net.TCPAddr).Port
	if err := Reverse(ctx, c, port); err != nil {
		t.Fatal(err)
	}
	if got := <-d.reverseOK; got != fmt.Sprintf("tcp:%d;tcp:%d", port, port) {
		t.Fatalf("reverse 参数 %s", got)
	}
	d.openDevice <- fmt.Sprintf("tcp:%d", port)
	select {
	case got := <-d.reverseOK:
		if got != "echo:ping" {
			t.Fatalf("回显 %q", got)
		}
	case <-ctx.Done():
		t.Fatal("没有收到回显")
	}

	// 再连一次：密钥已经被允许，直接通过
	host2, dev2 := newMemPipes()
	d2 := &fakeDevice{t: t, p: dev2, known: d.known, gotKey: make(chan string, 1), openDevice: make(chan string)}
	go d2.run()
	defer close(d2.openDevice)
	states = nil
	c2, err := Handshake(ctx, host2, NewKeys("", "test"), func(s State) { states = append(states, s) })
	if err != nil {
		t.Fatal(err)
	}
	c2.Close()
	if len(states) != 0 {
		t.Fatalf("允许过的电脑不应再等：%v", states)
	}
}

func TestHandshakeCancel(t *testing.T) {
	keys := newTestKeys(t)
	host, dev := newMemPipes()
	d := &fakeDevice{t: t, p: dev, gotKey: make(chan string, 1), openDevice: make(chan string)} // 用户一直不点允许
	go d.run()
	defer close(d.openDevice)
	ctx, cancel := context.WithCancel(context.Background())
	go func() { <-d.gotKey; cancel() }()
	_, err := Handshake(ctx, host, keys, nil)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("应返回取消：%v", err)
	}
}

func TestOpenRejected(t *testing.T) {
	keys := newTestKeys(t)
	host, dev := newMemPipes()
	d := &fakeDevice{t: t, p: dev, acceptKey: true, gotKey: make(chan string, 1), openDevice: make(chan string)}
	go d.run()
	defer close(d.openDevice)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, err := Handshake(ctx, host, keys, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if _, err := c.Open(ctx, "nosuch:"); err == nil {
		t.Fatal("不支持的服务应失败")
	}
	// 不允许的地址：手机发起的连接被拒绝，不影响连接
	if _, err := Shell(ctx, c, "getprop ro.serialno"); err != nil {
		t.Fatal(err)
	}
}

func TestParserResync(t *testing.T) {
	var p parser
	msgs, dropped := p.feed([]byte("garbage-from-last-run-garbage-from-last-run"))
	if len(msgs) != 0 || dropped == 0 {
		t.Fatal("残留数据应丢掉")
	}
	m := message{cmd: cmdWRTE, arg0: 1, arg1: 2, data: []byte("hi")}
	msgs, _ = p.feed(encodeHeader(m))
	if len(msgs) != 0 {
		t.Fatal("数据还没到")
	}
	msgs, _ = p.feed([]byte("hi"))
	if len(msgs) != 1 || string(msgs[0].data) != "hi" || msgs[0].arg1 != 2 {
		t.Fatalf("%v", msgs)
	}
}

func TestServiceStatus(t *testing.T) {
	if _, err := serviceStatus("OKAYOKAY"); err != nil {
		t.Fatal(err)
	}
	if rest, err := serviceStatus("OKAY0005hello"); err != nil || rest != "0005hello" {
		t.Fatal(rest, err)
	}
	if _, err := serviceStatus("FAIL0009not found"); err == nil || !strings.Contains(err.Error(), "not found") {
		t.Fatal(err)
	}
}

// 本机装过 adb 时：用 adb 生成的 adbkey 算出的公钥要和 adbkey.pub 一样（验证公钥格式）
func TestPublicKeyMatchesADB(t *testing.T) {
	dir := androidDir()
	priv, err := readKey(filepath.Join(dir, "adbkey"))
	if err != nil {
		t.Skip("本机没有 adb 的密钥")
	}
	pub, err := os.ReadFile(filepath.Join(dir, "adbkey.pub"))
	if err != nil {
		t.Skip("没有 adbkey.pub")
	}
	want := strings.Fields(string(pub))[0]
	if got := base64.StdEncoding.EncodeToString(encodePublicKey(&priv.PublicKey)); got != want {
		t.Fatal("公钥和 adb 算的不一样")
	}
}
