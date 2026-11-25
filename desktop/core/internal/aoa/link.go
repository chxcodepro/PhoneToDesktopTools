package aoa

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"log"
	"net"
	"sync"
	"time"
)

// transport 配件的一对 bulk 端点。Read 一次读一个 USB 传输（最多 len(p) 字节），一段时间没有数据返回 errTimeout；
// Write 一次写一个 USB 传输。Read 和 Write 会在不同的协程里同时调用。
type transport interface {
	Read(p []byte) (int, error)
	Write(p []byte) error
	Close() error
}

var errTimeout = errors.New("超时")

// readBufSize 每次读取的缓冲：16 KiB，是 512 和 1024 的整数倍（bulk 读请求的长度要是包大小的整数倍）
const readBufSize = 16384

// helloTimeout 这么久没收到手机的心跳，就认为手机端已经关了（App 被结束等），作废所有流
const helloTimeout = 6 * time.Second

// writeChunks 把数据分成若干次 bulk 写入：每次不超过 maxWrite，长度不能是 512 的整数倍（否则对方的读请求等不到短包）
func writeChunks(t transport, data []byte) error {
	for len(data) > 0 {
		n := len(data)
		if n > maxWrite {
			n = maxWrite
		}
		if n%usbPacket == 0 {
			n-- // 留一个字节给下一次写：两次都是短包
		}
		if err := t.Write(data[:n]); err != nil {
			return err
		}
		data = data[n:]
	}
	return nil
}

// linkHooks 链路和管理器之间的回调
type linkHooks struct {
	// dial 连接本机服务（每个流一条）
	dial func() (net.Conn, error)
	// config 手机打开配件后要发给它的连接参数；ok=false 表示暂不允许连接（用户在电脑上点了断开），只回心跳
	config func(h helloMsg) (c configMsg, ok bool)
	// hello 收到握手（第一次和每次心跳都会调用）
	hello func(h helloMsg, configured bool)
	// phoneGone 心跳超时（手机端 App 关了，但数据线还插着）
	phoneGone func()
}

// link 电脑这一端的多路复用链路
type link struct {
	t     transport
	hooks linkHooks
	now   func() time.Time

	out    chan []byte   // 待写出的已编码帧
	done   chan struct{} // 链路结束
	doneMu sync.Once
	err    error

	mu         sync.Mutex
	streams    map[uint32]*stream
	nonce      string
	configured bool
	lastHello  time.Time
}

func newLink(t transport, hooks linkHooks) *link {
	return &link{
		t: t, hooks: hooks, now: time.Now,
		out:     make(chan []byte, 256),
		done:    make(chan struct{}),
		streams: map[uint32]*stream{},
	}
}

// stop 结束链路（出错或外部取消），只生效一次
func (l *link) stop(err error) {
	l.doneMu.Do(func() {
		l.err = err
		close(l.done)
		_ = l.t.Close()
	})
}

// send 发送一帧；链路已结束时丢弃
func (l *link) send(typ byte, id uint32, payload []byte) {
	f := encodeFrame(typ, id, payload)
	select {
	case l.out <- f:
	case <-l.done:
	}
}

// run 运行到数据线拔出或 ctx 结束，返回原因
func (l *link) run(ctx context.Context) error {
	go l.writer()
	go func() {
		select {
		case <-ctx.Done():
			l.stop(ctx.Err())
		case <-l.done:
		}
	}()
	buf := make([]byte, readBufSize)
	var dec decoder
	badLogged := false
	for {
		n, err := l.t.Read(buf)
		select {
		case <-l.done:
			l.resetStreams()
			return l.err
		default:
		}
		if errors.Is(err, errTimeout) {
			l.checkHello()
			continue
		}
		if err != nil {
			l.stop(err)
			l.resetStreams()
			return err
		}
		frames, bad := dec.feed(buf[:n])
		// 拔线、切换 USB 调试时最后几次传输会被截断，常连着出现好几次：每条链路只记一次
		if bad && !badLogged {
			badLogged = true
			log.Printf("免调试连接：收到格式不对的数据，已丢弃（拔线时出现属正常）")
		}
		for _, f := range frames {
			l.handle(f)
		}
		l.checkHello()
	}
}

// writer 把待发的帧攒成不超过 maxWrite 的一批写出去
func (l *link) writer() {
	var batch, carry []byte
	for {
		batch = batch[:0]
		if carry != nil {
			batch = append(batch, carry...)
			carry = nil
		} else {
			select {
			case f := <-l.out:
				batch = append(batch, f...)
			case <-l.done:
				return
			}
		}
	more:
		for len(batch) < maxWrite {
			select {
			case f := <-l.out:
				if len(batch)+len(f) > maxWrite {
					carry = f
					break more
				}
				batch = append(batch, f...)
			default:
				break more
			}
		}
		if err := writeChunks(l.t, batch); err != nil {
			l.stop(err)
			return
		}
	}
}

func (l *link) handle(f frame) {
	switch f.typ {
	case tHello:
		var h helloMsg
		if json.Unmarshal(f.payload, &h) != nil {
			return
		}
		l.mu.Lock()
		l.lastHello = l.now()
		fresh := h.Nonce != l.nonce
		if fresh {
			l.nonce = h.Nonce
			l.configured = false
		}
		needConfig := !l.configured
		l.mu.Unlock()
		if fresh {
			l.resetStreams() // 手机端重新打开了配件：旧的流都已失效
		}
		sent := false
		if needConfig {
			if c, ok := l.hooks.config(h); ok {
				c.V, c.Nonce = 1, h.Nonce
				l.send(tConfig, 0, mustJSON(c))
				l.mu.Lock()
				l.configured = true
				l.mu.Unlock()
				sent = true
			}
		}
		if !sent {
			l.send(tPong, 0, nil)
		}
		if l.hooks.hello != nil {
			l.mu.Lock()
			configured := l.configured
			l.mu.Unlock()
			l.hooks.hello(h, configured)
		}
	case tOpen:
		l.mu.Lock()
		ok := l.configured && l.streams[f.id] == nil
		var s *stream
		if ok {
			s = newStream(l, f.id)
			l.streams[f.id] = s
		}
		l.mu.Unlock()
		if !ok {
			l.send(tClose, f.id, nil)
			return
		}
		go s.start()
	case tData:
		if s := l.stream(f.id); s != nil {
			s.push(f.payload)
		}
	case tClose:
		if s := l.stream(f.id); s != nil {
			s.remoteClose()
		}
	case tAck:
		if s := l.stream(f.id); s != nil && len(f.payload) == 4 {
			s.grant(int(binary.BigEndian.Uint32(f.payload)))
		}
	}
}

func (l *link) stream(id uint32) *stream {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.streams[id]
}

func (l *link) removeStream(s *stream) {
	l.mu.Lock()
	if l.streams[s.id] == s {
		delete(l.streams, s.id)
	}
	l.mu.Unlock()
}

// resetStreams 关闭所有流
func (l *link) resetStreams() {
	l.mu.Lock()
	all := l.streams
	l.streams = map[uint32]*stream{}
	l.mu.Unlock()
	for _, s := range all {
		s.abort()
	}
}

// checkHello 心跳超时：手机端 App 关了。作废所有流，等它重新打开配件后再握手
func (l *link) checkHello() {
	l.mu.Lock()
	gone := l.nonce != "" && l.now().Sub(l.lastHello) > helloTimeout
	if gone {
		l.nonce = ""
		l.configured = false
	}
	l.mu.Unlock()
	if gone {
		l.resetStreams()
		if l.hooks.phoneGone != nil {
			l.hooks.phoneGone()
		}
	}
}

// unconfigure 用户在电脑上点了断开：关闭所有流，之后只回心跳、不再发连接参数，直到手机端重新打开配件
func (l *link) unconfigure() {
	l.mu.Lock()
	l.configured = false
	l.mu.Unlock()
	l.resetStreams()
}

// stream 一条手机上的 TCP 连接，对应电脑本机服务的一条连接
type stream struct {
	id uint32
	l  *link

	mu           sync.Mutex
	cond         *sync.Cond
	conn         net.Conn
	queue        [][]byte // 收到、还没写给本机服务的数据
	sendWin      int      // 还能发给手机多少字节
	remoteClosed bool     // 手机那头已关闭：队列写完后关闭本机连接
	closed       bool
}

func newStream(l *link, id uint32) *stream {
	s := &stream{id: id, l: l, sendWin: streamWindow}
	s.cond = sync.NewCond(&s.mu)
	return s
}

// start 连接本机服务，然后双向转发
func (s *stream) start() {
	conn, err := s.l.hooks.dial()
	if err != nil {
		log.Printf("免调试连接：连接本机服务失败：%v", err)
		s.l.send(tClose, s.id, nil)
		s.l.removeStream(s)
		s.abort()
		return
	}
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		_ = conn.Close()
		return
	}
	s.conn = conn
	s.mu.Unlock()
	go s.toConn()
	s.fromConn()
}

// fromConn 本机服务 → 手机
func (s *stream) fromConn() {
	buf := make([]byte, maxPayload)
	for {
		n, err := s.conn.Read(buf)
		if n > 0 {
			s.mu.Lock()
			for s.sendWin < n && !s.closed {
				s.cond.Wait()
			}
			if s.closed {
				s.mu.Unlock()
				return
			}
			s.sendWin -= n
			s.mu.Unlock()
			s.l.send(tData, s.id, append([]byte(nil), buf[:n]...))
		}
		if err != nil {
			s.mu.Lock()
			tell := !s.closed && !s.remoteClosed
			s.mu.Unlock()
			if tell && !errors.Is(err, net.ErrClosed) {
				s.l.send(tClose, s.id, nil)
			}
			s.finish()
			return
		}
	}
}

// toConn 手机 → 本机服务。写出后回 tAck，手机才能继续发
func (s *stream) toConn() {
	unacked := 0
	for {
		s.mu.Lock()
		for len(s.queue) == 0 && !s.remoteClosed && !s.closed {
			s.cond.Wait()
		}
		if s.closed || len(s.queue) == 0 { // 已关闭，或对方关闭且数据都写完了
			s.mu.Unlock()
			if unacked > 0 {
				s.l.send(tAck, s.id, ackPayload(unacked))
			}
			s.finish()
			return
		}
		p := s.queue[0]
		s.queue = s.queue[1:]
		last := len(s.queue) == 0
		s.mu.Unlock()
		if _, err := s.conn.Write(p); err != nil {
			s.l.send(tClose, s.id, nil)
			s.finish()
			return
		}
		unacked += len(p)
		if unacked >= ackEvery || last {
			s.l.send(tAck, s.id, ackPayload(unacked))
			unacked = 0
		}
	}
}

func (s *stream) push(p []byte) {
	s.mu.Lock()
	if !s.closed && !s.remoteClosed {
		s.queue = append(s.queue, p)
		s.cond.Broadcast()
	}
	s.mu.Unlock()
}

func (s *stream) grant(n int) {
	s.mu.Lock()
	s.sendWin += n
	s.cond.Broadcast()
	s.mu.Unlock()
}

func (s *stream) remoteClose() {
	s.mu.Lock()
	s.remoteClosed = true
	s.cond.Broadcast()
	s.mu.Unlock()
}

// finish 正常结束：关闭本机连接，从链路上摘掉
func (s *stream) finish() {
	s.abort()
	s.l.removeStream(s)
}

// abort 立即关闭（链路断开、手机端重开等）
func (s *stream) abort() {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	conn := s.conn
	s.queue = nil
	s.cond.Broadcast()
	s.mu.Unlock()
	if conn != nil {
		_ = conn.Close()
	}
}
