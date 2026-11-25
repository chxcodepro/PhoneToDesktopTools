// Package aoa 免调试连接：用 Android Open Accessory（配件模式）协议经数据线连接手机，不需要开 USB 调试、不需要 adb。
//
// 流程：
//  1. 电脑发三个厂商控制请求（51 查协议版本、52 发识别字符串、53 启动），手机断开重连，变成 Google 的配件设备 18D1:2D00；
//  2. 手机上弹出「用 PhoneToDesktop 打开」，App 打开配件后，双方通过一对 bulk 端点收发字节；
//  3. 这条管道上跑一个很薄的多路复用协议（本文件）：手机本机监听一个回环端口，每条 TCP 连接对应一个流，
//     电脑端把每个流接到本机的服务端口（和 adb reverse 隧道效果相同），所以手机端照旧用 ws://127.0.0.1:<端口>/mcp?token=… 连接。
//
// 帧格式（大端）：
//
//	0xA5 | 类型 1 字节 | 流编号 4 字节 | 长度 2 字节 | 内容
//
// 手机端的实现见 mobile/modules/p2d-accessory（Kotlin），两边必须一致。
package aoa

import (
	"encoding/binary"
	"encoding/json"
)

const (
	frameMagic = 0xA5
	headerLen  = 8

	tHello  = 1 // 手机 → 电脑：打开配件后每秒一次（也是心跳），内容 helloMsg
	tConfig = 2 // 电脑 → 手机：连接参数（令牌等），内容 configMsg
	tPong   = 3 // 电脑 → 手机：心跳回复
	tOpen   = 4 // 手机 → 电脑：手机上新建了一条 TCP 连接（流编号由手机分配）
	tData   = 5 // 双向：流数据
	tClose  = 6 // 双向：流已关闭
	tAck    = 7 // 双向：已写出的字节数（4 字节），对方据此增加可发送额度

	// maxPayload 一帧最多带多少数据
	maxPayload = 8192
	// maxWrite 一次 bulk 写入最多多少字节：手机端每次读 16 KiB，写入不能超过它
	maxWrite = 15000
	// streamWindow 每个流、每个方向最多有多少字节在途（对方还没写出）：管道读取方永远不会因为某个流写得慢而阻塞
	streamWindow = 256 << 10
	// ackEvery 攒够这么多字节回一次 tAck（队列写空时也会回）
	ackEvery = 64 << 10
	// usbPacket 高速 USB bulk 包大小。一次写入的长度正好是它的整数倍时，对方的读请求要等到短包才结束，
	// 所以这种长度拆成两次写（见 writeChunks）。超高速是 1024，也是 512 的整数倍，一并覆盖。
	usbPacket = 512
)

// AOA 协议的厂商控制请求
const (
	reqGetProtocol = 51
	reqSendString  = 52
	reqStart       = 53
)

// 配件识别字符串的序号（SEND_STRING 的 wIndex）
const (
	strManufacturer = iota
	strModel
	strDescription
	strVersion
	strURI
	strSerial
)

// 识别字符串：手机端 res/xml/p2d_accessory_filter.xml 按厂商和型号匹配，两边要一致
const (
	accessoryManufacturer = "PhoneToDesktop"
	accessoryModel        = "P2D"
	accessoryDescription  = "PhoneToDesktop 电脑端"
	accessoryVersion      = "1"
	// 手机上没装 App 时，系统会提示用浏览器打开这个地址
	accessoryURI = "https://github.com/chxcodepro/PhoneToDesktopTools/releases"
)

// Google 配件模式的厂商 ID 和产品 ID（2D00 配件、2D01 配件 + adb，2D02~2D05 带音频，不请求但也认）
const (
	googleVID       = 0x18D1
	accessoryPIDMin = 0x2D00
	accessoryPIDMax = 0x2D05
)

func isAccessory(vid, pid uint16) bool {
	return vid == googleVID && pid >= accessoryPIDMin && pid <= accessoryPIDMax
}

type frame struct {
	typ     byte
	id      uint32
	payload []byte
}

// appendFrame 把一帧编码后追加到 dst
func appendFrame(dst []byte, typ byte, id uint32, payload []byte) []byte {
	var h [headerLen]byte
	h[0] = frameMagic
	h[1] = typ
	binary.BigEndian.PutUint32(h[2:6], id)
	binary.BigEndian.PutUint16(h[6:8], uint16(len(payload)))
	dst = append(dst, h[:]...)
	return append(dst, payload...)
}

func encodeFrame(typ byte, id uint32, payload []byte) []byte {
	return appendFrame(make([]byte, 0, headerLen+len(payload)), typ, id, payload)
}

// decoder 把管道读到的字节流切成帧。一帧可能跨两次读取，未读完的部分留到下次。
type decoder struct{ buf []byte }

// feed 追加数据，返回完整的帧。遇到格式错误（magic 不对、长度超限）丢弃已缓存的数据并返回 bad=true：
// 正常情况下不会发生，只在对方中途重启、留下半帧时出现，丢掉后等对方重新握手即可。
func (d *decoder) feed(p []byte) (frames []frame, bad bool) {
	d.buf = append(d.buf, p...)
	for len(d.buf) >= headerLen {
		if d.buf[0] != frameMagic {
			d.buf = d.buf[:0]
			return frames, true
		}
		n := int(binary.BigEndian.Uint16(d.buf[6:8]))
		if n > maxPayload {
			d.buf = d.buf[:0]
			return frames, true
		}
		if len(d.buf) < headerLen+n {
			break
		}
		payload := make([]byte, n)
		copy(payload, d.buf[headerLen:headerLen+n])
		frames = append(frames, frame{typ: d.buf[1], id: binary.BigEndian.Uint32(d.buf[2:6]), payload: payload})
		d.buf = d.buf[headerLen+n:]
	}
	if len(d.buf) == 0 {
		d.buf = nil // 释放底层数组
	}
	return frames, false
}

// helloMsg 手机打开配件后发来的握手 / 心跳
type helloMsg struct {
	V     int    `json:"v"`
	Nonce string `json:"nonce"` // 每次打开配件随机生成：变了说明手机端重新打开过，旧的流全部作废
	Name  string `json:"name"`  // 手机名（如「OnePlus 13」）
	App   string `json:"app"`   // 手机端版本
}

// configMsg 电脑发给手机的连接参数，手机端拼成 p2d://connect?… 交给现有的连接逻辑
type configMsg struct {
	V     int    `json:"v"`
	Nonce string `json:"nonce"`
	Token string `json:"token"`
	Host  string `json:"host"`
	OS    string `json:"os"`
	PCID  string `json:"pcid,omitempty"`
}

func mustJSON(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}

func ackPayload(n int) []byte {
	b := make([]byte, 4)
	binary.BigEndian.PutUint32(b, uint32(n))
	return b
}
