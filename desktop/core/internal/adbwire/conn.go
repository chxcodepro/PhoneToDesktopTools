package adbwire

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"strings"
	"sync"
	"time"

	"p2d/core/internal/usbio"
)

// Pipe 和手机之间的字节通道（USB 的一对 bulk 端点，见 usbio.Pipe）。Write 一次写一条消息的消息头或数据。
type Pipe interface {
	Read(p []byte) (int, error)
	Write(p []byte) error
	Close() error
}

// Opener 打开手机上的一个服务（shell:…、exec:…、reverse:…），返回双向的数据流
type Opener interface {
	Open(ctx context.Context, service string) (io.ReadWriteCloser, error)
}

// State 握手时的状态
type State string

const (
	StateUnauthorized State = "unauthorized" // 等用户在手机上点「允许 USB 调试」
	StateOffline      State = "offline"      // 手机没有回应
)

var errClosed = errors.New("连接已关闭")

// Conn 经 USB 和手机 adbd 的连接
type Conn struct {
	pipe    Pipe
	maxData int // 手机一条消息最多收多少字节
	banner  string

	wmu sync.Mutex // 一条消息的消息头和数据要连着写

	mu      sync.Mutex
	streams map[uint32]*Stream
	nextID  uint32
	reverse map[string]string // 允许手机发起的连接：手机上的地址（tcp:39272）→ 电脑上的地址

	done    chan struct{}
	err     error
	errOnce sync.Once

	parser parser
	queue  []message // 握手时多读出来的消息
	rbuf   []byte
}

func newConn(p Pipe) *Conn {
	return &Conn{
		pipe: p, maxData: 4096, streams: map[uint32]*Stream{}, reverse: map[string]string{},
		done: make(chan struct{}), rbuf: make([]byte, 65536),
	}
}

// Banner 手机在握手时发来的说明，如 device::ro.product.name=…;ro.product.model=…;features=…
func (c *Conn) Banner() string { return c.banner }

// Model 手机型号（握手说明里的 ro.product.model）
func (c *Conn) Model() string {
	for _, f := range strings.Split(c.banner, ";") {
		if i := strings.Index(f, "ro.product.model="); i >= 0 {
			return f[i+len("ro.product.model="):]
		}
	}
	return ""
}

// Done 连接断开后关闭
func (c *Conn) Done() <-chan struct{} { return c.done }

// Err 断开的原因
func (c *Conn) Err() error {
	select {
	case <-c.done:
		return c.err
	default:
		return nil
	}
}

var debug = os.Getenv("P2D_ADB_DEBUG") != ""

func (c *Conn) send(m message) error {
	if debug {
		log.Printf("ADB → %v", m)
	}
	c.wmu.Lock()
	defer c.wmu.Unlock()
	select {
	case <-c.done:
		return c.err
	default:
	}
	if err := c.pipe.Write(encodeHeader(m)); err != nil {
		c.fail(fmt.Errorf("USB 写入失败：%w", err))
		return err
	}
	if len(m.data) > 0 {
		if err := c.pipe.Write(m.data); err != nil {
			c.fail(fmt.Errorf("USB 写入失败：%w", err))
			return err
		}
	}
	return nil
}

// readMsg 读下一条消息（握手时和读取协程里用）
func (c *Conn) readMsg() (message, error) {
	for len(c.queue) == 0 {
		n, err := c.pipe.Read(c.rbuf[:c.parser.need(len(c.rbuf))])
		if errors.Is(err, usbio.ErrTimeout) {
			select {
			case <-c.done:
				return message{}, c.err
			default:
				continue
			}
		}
		if err != nil {
			return message{}, err
		}
		if debug {
			log.Printf("ADB USB 读到 %d 字节", n)
		}
		if n == 0 {
			continue
		}
		msgs, dropped := c.parser.feed(c.rbuf[:n])
		if dropped > 0 {
			log.Printf("ADB：丢掉了 %d 字节对不上的数据", dropped)
		}
		c.queue = append(c.queue, msgs...)
	}
	m := c.queue[0]
	c.queue = c.queue[1:]
	if debug {
		log.Printf("ADB ← %v", m)
	}
	return m, nil
}

// Handshake 握手并通过授权。onState 在等用户点「允许 USB 调试」、手机没有回应时调用。
// ctx 结束时关闭 pipe 并返回错误；成功后 pipe 归 Conn 所有，Close 时关闭。
func Handshake(ctx context.Context, p Pipe, keys *Keys, onState func(State)) (*Conn, error) {
	c := newConn(p)
	finished := make(chan struct{})
	defer close(finished)
	go func() {
		select {
		case <-ctx.Done():
			c.fail(ctx.Err())
		case <-finished:
		}
	}()
	msgs := make(chan result)
	go c.reader(msgs)
	hello := message{cmd: cmdCNXN, arg0: version, arg1: hostMaxPayload, data: []byte("host::\x00")}
	if err := c.send(hello); err != nil {
		c.fail(err)
		return nil, err
	}
	signed := false
	sentKey := false
	quiet := time.NewTimer(5 * time.Second)
	defer quiet.Stop()
	for {
		var r result
		select {
		case r = <-msgs:
		case <-quiet.C:
			// 手机一直不回应：再打一次招呼（上一个程序断开时手机可能还在等它）
			if onState != nil && !sentKey {
				onState(StateOffline)
			}
			if !sentKey {
				_ = c.send(hello)
			}
			quiet.Reset(5 * time.Second)
			continue
		case <-c.done:
			return nil, c.err
		}
		if r.err != nil {
			c.fail(r.err)
			return nil, r.err
		}
		m := r.m
		switch m.cmd {
		case cmdCNXN:
			c.maxData = int(m.arg1)
			if c.maxData <= 0 || c.maxData > 1<<20 {
				c.maxData = 4096
			}
			c.banner = strings.TrimRight(string(m.data), "\x00")
			return c, nil
		case cmdAUTH:
			if m.arg0 != authToken {
				continue
			}
			if !signed {
				// 先用密钥签名：手机以前允许过这把密钥就直接通过
				signed = true
				sig, err := keys.sign(m.data)
				if err != nil {
					c.fail(err)
					return nil, err
				}
				_ = c.send(message{cmd: cmdAUTH, arg0: authSignature, data: sig})
				continue
			}
			if !sentKey {
				// 签名没通过：把公钥发给手机，手机弹出「允许 USB 调试吗？」
				sentKey = true
				pub, err := keys.publicKey()
				if err != nil {
					c.fail(err)
					return nil, err
				}
				_ = c.send(message{cmd: cmdAUTH, arg0: authRSAPublicKey, data: pub})
			}
			if onState != nil {
				onState(StateUnauthorized)
			}
		case cmdSTLS:
			err := errors.New("手机要求加密连接（无线调试），不支持")
			c.fail(err)
			return nil, err
		}
		quiet.Reset(5 * time.Second)
	}
}

func (c *Conn) fail(err error) {
	c.errOnce.Do(func() {
		if err == nil {
			err = errClosed
		}
		c.err = err
		close(c.done)
		_ = c.pipe.Close()
		c.mu.Lock()
		streams := c.streams
		c.streams = map[uint32]*Stream{}
		c.mu.Unlock()
		for _, s := range streams {
			s.closeLocal()
		}
	})
}

// Close 断开连接
func (c *Conn) Close() error {
	c.fail(errClosed)
	return nil
}

type result struct {
	m   message
	err error
}

// reader 唯一读 USB 的协程（Windows 上读会一直等到有数据，不能在握手的循环里直接读）。
// 握手时把消息交给 Handshake；收到 CNXN（握手完成）后自己处理之后的消息。
func (c *Conn) reader(hs chan<- result) {
	for {
		m, err := c.readMsg()
		if hs != nil {
			select {
			case hs <- result{m, err}:
			case <-c.done:
				return
			}
			if err != nil {
				return
			}
			if m.cmd == cmdCNXN {
				hs = nil
			}
			continue
		}
		if err != nil {
			c.fail(fmt.Errorf("USB 读取失败：%w", err))
			return
		}
		c.dispatch(m)
	}
}

// dispatch 处理握手之后的消息。arg0 是对方的流号，arg1 是我们的流号。
func (c *Conn) dispatch(m message) {
	switch m.cmd {
	case cmdOKAY:
		if s := c.stream(m.arg1); s != nil {
			s.onOkay(m.arg0)
		} else if m.arg0 != 0 {
			// 我们已经放弃的流（打开时超时）手机才答应：关掉它
			_ = c.send(message{cmd: cmdCLSE, arg0: m.arg1, arg1: m.arg0})
		}
	case cmdWRTE:
		if s := c.stream(m.arg1); s != nil {
			s.onData(m.data)
		} else {
			_ = c.send(message{cmd: cmdCLSE, arg0: m.arg1, arg1: m.arg0})
		}
	case cmdCLSE:
		if s := c.stream(m.arg1); s != nil {
			c.removeStream(s.local)
			s.closeLocal()
		}
	case cmdOPEN:
		c.onOpen(m.arg0, strings.TrimRight(string(m.data), "\x00"))
	case cmdCNXN:
		c.fail(errors.New("手机重新建立了 ADB 连接"))
	}
}

func (c *Conn) stream(id uint32) *Stream {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.streams[id]
}

func (c *Conn) removeStream(id uint32) {
	c.mu.Lock()
	delete(c.streams, id)
	c.mu.Unlock()
}

func (c *Conn) newStream(remote uint32) (*Stream, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	select {
	case <-c.done:
		return nil, c.err
	default:
	}
	c.nextID++
	if c.nextID == 0 {
		c.nextID = 1
	}
	s := &Stream{
		c: c, local: c.nextID, remote: remote,
		opened: make(chan struct{}), ack: make(chan struct{}, 1), data: make(chan []byte, 4), closed: make(chan struct{}),
	}
	if remote != 0 {
		close(s.opened)
	}
	c.streams[s.local] = s
	return s, nil
}

// Open 打开手机上的服务
func (c *Conn) Open(ctx context.Context, service string) (io.ReadWriteCloser, error) {
	s, err := c.newStream(0)
	if err != nil {
		return nil, err
	}
	if err := c.send(message{cmd: cmdOPEN, arg0: s.local, data: append([]byte(service), 0)}); err != nil {
		return nil, err
	}
	select {
	case <-s.opened:
		return s, nil
	case <-s.closed:
		if err := c.Err(); err != nil {
			return nil, err
		}
		return nil, fmt.Errorf("手机拒绝了 %s", service)
	case <-ctx.Done():
		s.Close()
		return nil, ctx.Err()
	}
}

// allowReverse 允许手机连接 dest（tcp:端口），连接转到电脑上的 addr
func (c *Conn) allowReverse(dest, addr string) {
	c.mu.Lock()
	c.reverse[dest] = addr
	c.mu.Unlock()
}

func (c *Conn) disallowReverse(dest string) {
	c.mu.Lock()
	delete(c.reverse, dest)
	c.mu.Unlock()
}

// onOpen 手机发起的连接（adb reverse 转发过来的）：连到电脑上的端口，两边互相转发
func (c *Conn) onOpen(remote uint32, dest string) {
	c.mu.Lock()
	addr, ok := c.reverse[dest]
	c.mu.Unlock()
	if !ok || remote == 0 {
		_ = c.send(message{cmd: cmdCLSE, arg1: remote})
		return
	}
	s, err := c.newStream(remote)
	if err != nil {
		return
	}
	go func() {
		tc, err := net.DialTimeout("tcp", addr, 3*time.Second)
		if err != nil {
			log.Printf("ADB：转发到 %s 失败：%v", addr, err)
			c.removeStream(s.local)
			s.closeLocal()
			_ = c.send(message{cmd: cmdCLSE, arg1: remote})
			return
		}
		if err := c.send(message{cmd: cmdOKAY, arg0: s.local, arg1: remote}); err != nil {
			tc.Close()
			return
		}
		go func() {
			_, _ = io.Copy(tc, s)
			if cw, ok := tc.(interface{ CloseWrite() error }); ok {
				_ = cw.CloseWrite()
			} else {
				tc.Close()
			}
		}()
		_, _ = io.Copy(s, tc)
		s.Close()
		tc.Close()
	}()
}

// Stream 连接里的一路数据流
type Stream struct {
	c      *Conn
	local  uint32
	remote uint32 // 收到手机的 OKAY 后才知道（之后不再改变）

	opened chan struct{}
	ack    chan struct{}
	data   chan []byte
	closed chan struct{}

	mu         sync.Mutex
	closedOnce bool
	remoteGone bool

	rmu     sync.Mutex
	pending []byte
	wmu     sync.Mutex
}

func (s *Stream) onOkay(remote uint32) {
	s.mu.Lock()
	if s.remote == 0 {
		s.remote = remote
		s.mu.Unlock()
		close(s.opened)
		return
	}
	s.mu.Unlock()
	select {
	case s.ack <- struct{}{}:
	default:
	}
}

func (s *Stream) onData(b []byte) {
	select {
	case s.data <- b:
	default:
		// 手机没等我们确认就接着发（不应该发生）：关掉这一路
		log.Printf("ADB：数据流 %d 收到太多未确认的数据，关闭", s.local)
		s.Close()
	}
}

// closeLocal 标记为已关闭（手机关闭了这一路，或整个连接断了），不再给手机发 CLSE
func (s *Stream) closeLocal() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.remoteGone = true
	if !s.closedOnce {
		s.closedOnce = true
		close(s.closed)
	}
}

func (s *Stream) Read(p []byte) (int, error) {
	s.rmu.Lock()
	defer s.rmu.Unlock()
	if len(s.pending) == 0 {
		select {
		case b := <-s.data:
			s.pending = b
		case <-s.closed:
			select { // 关闭前收到的数据要先读完
			case b := <-s.data:
				s.pending = b
			default:
				return 0, io.EOF
			}
		}
		// 收下了这条数据，告诉手机可以发下一条
		s.mu.Lock()
		gone := s.remoteGone
		s.mu.Unlock()
		if !gone {
			_ = s.c.send(message{cmd: cmdOKAY, arg0: s.local, arg1: s.remote})
		}
	}
	n := copy(p, s.pending)
	s.pending = s.pending[n:]
	return n, nil
}

func (s *Stream) Write(p []byte) (int, error) {
	s.wmu.Lock()
	defer s.wmu.Unlock()
	written := 0
	for len(p) > 0 {
		select {
		case <-s.closed:
			return written, io.ErrClosedPipe
		default:
		}
		n := len(p)
		if n > s.c.maxData {
			n = s.c.maxData
		}
		if err := s.c.send(message{cmd: cmdWRTE, arg0: s.local, arg1: s.remote, data: p[:n]}); err != nil {
			return written, err
		}
		select {
		case <-s.ack:
		case <-s.closed:
			return written, io.ErrClosedPipe
		}
		written += n
		p = p[n:]
	}
	return written, nil
}

// Close 关闭这一路
func (s *Stream) Close() error {
	s.mu.Lock()
	first := !s.closedOnce
	if first {
		s.closedOnce = true
		close(s.closed)
	}
	gone := s.remoteGone
	remote := s.remote
	s.mu.Unlock()
	if first {
		s.c.removeStream(s.local)
		if !gone && remote != 0 {
			_ = s.c.send(message{cmd: cmdCLSE, arg0: s.local, arg1: remote})
		}
	}
	return nil
}
