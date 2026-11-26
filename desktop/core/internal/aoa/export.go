package aoa

// 供 iPhone 数据线连接（internal/iphone，经 usbmuxd）复用同一套多路复用协议：
// iPhone 上的 App 监听一个端口，电脑经 usbmuxd 连上后，这条连接就是「管道」，帧格式、握手、流量控制都和免调试连接相同。

import (
	"context"
	"net"
)

// Transport 管道：Read 一段时间没有数据时返回 ErrTimeout（用来检查心跳），Read 和 Write 会在不同协程里同时调用
type Transport = transport

// ErrTimeout Transport.Read 超时
var ErrTimeout = errTimeout

// Hello 手机发来的握手 / 心跳
type Hello = helloMsg

// LinkConfig 发给手机的连接参数
type LinkConfig = configMsg

// Hooks 链路回调，含义见 linkHooks
type Hooks struct {
	Dial      func() (net.Conn, error)
	Config    func(h Hello) (LinkConfig, bool)
	Hello     func(h Hello, configured bool)
	PhoneGone func()
}

// Link 一条多路复用链路
type Link struct{ l *link }

// NewLink 在管道 t 上建立链路
func NewLink(t Transport, h Hooks) *Link {
	return &Link{newLink(t, linkHooks{dial: h.Dial, config: h.Config, hello: h.Hello, phoneGone: h.PhoneGone})}
}

// Run 运行到管道断开或 ctx 结束
func (x *Link) Run(ctx context.Context) error { return x.l.run(ctx) }

// Unconfigure 用户在电脑上点了断开：关掉所有流，之后只回心跳、不再发连接参数
func (x *Link) Unconfigure() { x.l.unconfigure() }
