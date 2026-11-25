// Package adbwire 电脑端自己实现的 ADB 连接（不再随包带 adb）：
//   - 直接经 USB 和手机的 adbd 通信（conn.go）：握手、用电脑端密钥通过手机授权（auth.go）、多路数据流；
//   - 电脑上已经有 adb 后台服务（如 Android Studio 的）在运行、占着手机时，经它的 5037 端口通信（server.go）。
//
// 两种方式都实现 Opener，上面的命令（执行 shell、装 APK、端口反向转发）见 services.go。
// 协议见 AOSP packages/modules/adb 的 protocol.txt、SERVICES.TXT。
package adbwire

import (
	"encoding/binary"
	"errors"
	"fmt"
)

// 消息命令
const (
	cmdSYNC = 0x434e5953
	cmdCNXN = 0x4e584e43
	cmdAUTH = 0x48545541
	cmdOPEN = 0x4e45504f
	cmdOKAY = 0x59414b4f
	cmdCLSE = 0x45534c43
	cmdWRTE = 0x45545257
	cmdSTLS = 0x534c5453
)

// AUTH 消息的类型（arg0）
const (
	authToken        = 1
	authSignature    = 2
	authRSAPublicKey = 3
)

const (
	// version 协议版本：0x01000001 起不再校验数据的校验和（我们发出的消息仍然带校验和，兼容老手机）
	version = 0x01000001
	// hostMaxPayload 我们一条消息最多收多少字节
	hostMaxPayload = 256 * 1024
	headerSize     = 24
)

type message struct {
	cmd, arg0, arg1 uint32
	data            []byte
}

func cmdName(c uint32) string {
	var b [4]byte
	binary.LittleEndian.PutUint32(b[:], c)
	return string(b[:])
}

func (m message) String() string {
	return fmt.Sprintf("%s(%d, %d, %d 字节)", cmdName(m.cmd), m.arg0, m.arg1, len(m.data))
}

func checksum(b []byte) uint32 {
	var s uint32
	for _, c := range b {
		s += uint32(c)
	}
	return s
}

func encodeHeader(m message) []byte {
	h := make([]byte, headerSize)
	binary.LittleEndian.PutUint32(h[0:], m.cmd)
	binary.LittleEndian.PutUint32(h[4:], m.arg0)
	binary.LittleEndian.PutUint32(h[8:], m.arg1)
	binary.LittleEndian.PutUint32(h[12:], uint32(len(m.data)))
	binary.LittleEndian.PutUint32(h[16:], checksum(m.data))
	binary.LittleEndian.PutUint32(h[20:], m.cmd^0xFFFFFFFF)
	return h
}

var errBadHeader = errors.New("消息头不对")

func knownCmd(c uint32) bool {
	switch c {
	case cmdSYNC, cmdCNXN, cmdAUTH, cmdOPEN, cmdOKAY, cmdCLSE, cmdWRTE, cmdSTLS:
		return true
	}
	return false
}

// decodeHeader 解析消息头，返回消息（不含数据）和数据长度
func decodeHeader(h []byte, maxPayload int) (message, int, error) {
	m := message{
		cmd:  binary.LittleEndian.Uint32(h[0:]),
		arg0: binary.LittleEndian.Uint32(h[4:]),
		arg1: binary.LittleEndian.Uint32(h[8:]),
	}
	n := binary.LittleEndian.Uint32(h[12:])
	magic := binary.LittleEndian.Uint32(h[20:])
	if !knownCmd(m.cmd) || magic != m.cmd^0xFFFFFFFF || int64(n) > int64(maxPayload) {
		return m, 0, errBadHeader
	}
	return m, int(n), nil
}

// parser 把 USB 读到的字节流切成消息。读到的不是消息头（上一个程序没读完的残留数据）时丢掉这一段，
// 等下一次读取：手机每条消息的消息头单独一次 USB 传输，从下一次传输开始又能对上。
type parser struct {
	buf []byte
}

// need 下一次读多少字节：和 adb 一样，消息头读 24 字节，数据按长度读（最多 max）
func (p *parser) need(max int) int {
	n := headerSize - len(p.buf)
	if len(p.buf) >= headerSize {
		if _, l, err := decodeHeader(p.buf[:headerSize], hostMaxPayload); err == nil {
			n = headerSize + l - len(p.buf)
		}
	}
	if n <= 0 || n > max {
		return max
	}
	return n
}

// feed 加入一次读到的数据，返回解析出的完整消息
func (p *parser) feed(b []byte) (msgs []message, dropped int) {
	p.buf = append(p.buf, b...)
	for len(p.buf) >= headerSize {
		m, n, err := decodeHeader(p.buf[:headerSize], hostMaxPayload)
		if err != nil {
			dropped += len(p.buf)
			p.buf = p.buf[:0]
			break
		}
		if len(p.buf) < headerSize+n {
			break
		}
		m.data = append([]byte(nil), p.buf[headerSize:headerSize+n]...)
		msgs = append(msgs, m)
		p.buf = p.buf[headerSize+n:]
	}
	if len(p.buf) == 0 {
		p.buf = nil // 释放大块数据
	}
	return msgs, dropped
}
