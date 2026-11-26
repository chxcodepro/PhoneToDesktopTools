package usbmux

import (
	"encoding/binary"
	"io"
	"net"
	"strings"
	"testing"
)

func TestPlistRoundTrip(t *testing.T) {
	b, err := encodePlist(map[string]any{"MessageType": "Connect", "DeviceID": 3, "PortNumber": 0x9A99, "Flag": true, "Name": "a<b"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b), "<string>a&lt;b</string>") {
		t.Fatalf("没有转义：%s", b)
	}
	v, err := decodePlist(b)
	if err != nil {
		t.Fatal(err)
	}
	m := dictOf(v)
	if stringOf(m["MessageType"]) != "Connect" || m["Flag"] != true || stringOf(m["Name"]) != "a<b" {
		t.Fatalf("解码结果不对：%#v", m)
	}
	if n, _ := intOf(m["PortNumber"]); n != 0x9A99 {
		t.Fatalf("端口不对：%v", m["PortNumber"])
	}
}

// usbmuxd 实际返回的设备列表（字段节选，含 USB 和 WiFi 两种设备）
const listReply = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>DeviceList</key>
	<array>
		<dict>
			<key>DeviceID</key><integer>5</integer>
			<key>MessageType</key><string>Attached</string>
			<key>Properties</key>
			<dict>
				<key>ConnectionSpeed</key><integer>480000000</integer>
				<key>ConnectionType</key><string>USB</string>
				<key>DeviceID</key><integer>5</integer>
				<key>LocationID</key><integer>336592896</integer>
				<key>ProductID</key><integer>4776</integer>
				<key>SerialNumber</key><string>00008110-001A2B3C4D5E801E</string>
				<key>USBSerialNumber</key><string>000081100001A2B3C4D5E801E</string>
			</dict>
		</dict>
		<dict>
			<key>DeviceID</key><integer>9</integer>
			<key>MessageType</key><string>Attached</string>
			<key>Properties</key>
			<dict>
				<key>ConnectionType</key><string>Network</string>
				<key>DeviceID</key><integer>9</integer>
				<key>EscapedFullServiceName</key><string>x</string>
				<key>NetworkAddress</key><data>EAIAAMCoAWQAAAAAAAAAAA==</data>
				<key>SerialNumber</key><string>00008030-000000000000002E</string>
			</dict>
		</dict>
	</array>
</dict>
</plist>`

func resultReply(n int) string {
	return `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>MessageType</key><string>Result</string><key>Number</key><integer>` +
		string(rune('0'+n)) + `</integer></dict></plist>`
}

func writeReply(c net.Conn, tag uint32, body string) {
	pkt := make([]byte, headerLen+len(body))
	binary.LittleEndian.PutUint32(pkt[0:], uint32(len(pkt)))
	binary.LittleEndian.PutUint32(pkt[4:], protoPlist)
	binary.LittleEndian.PutUint32(pkt[8:], msgPlist)
	binary.LittleEndian.PutUint32(pkt[12:], tag)
	copy(pkt[headerLen:], body)
	_, _ = c.Write(pkt)
}

func readRequest(t *testing.T, c net.Conn) (uint32, map[string]any) {
	var h [headerLen]byte
	if _, err := io.ReadFull(c, h[:]); err != nil {
		return 0, nil // Available() 只连一下就关
	}
	body := make([]byte, binary.LittleEndian.Uint32(h[0:])-headerLen)
	if _, err := io.ReadFull(c, body); err != nil {
		t.Error(err)
		return 0, nil
	}
	v, err := decodePlist(body)
	if err != nil {
		t.Error(err)
	}
	return binary.LittleEndian.Uint32(h[12:]), dictOf(v)
}

// fakeMux 假的 usbmuxd：ListDevices 回 listReply；Connect 到 39274 成功后回显，其他端口拒绝
func fakeMux(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	t.Setenv("P2D_USBMUXD", "tcp:"+ln.Addr().String())
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer c.Close()
				tag, m := readRequest(t, c)
				switch stringOf(m["MessageType"]) {
				case "ListDevices":
					writeReply(c, tag, listReply)
				case "Connect":
					port, _ := intOf(m["PortNumber"])
					if port != 0x6A99 { // 39274（0x996A）按大端放进整数
						writeReply(c, tag, resultReply(3))
						return
					}
					writeReply(c, tag, resultReply(0))
					_, _ = io.Copy(c, c)
				}
			}()
		}
	}()
}

func TestListAndConnect(t *testing.T) {
	fakeMux(t)
	if !Available() {
		t.Fatal("应能连上假的 usbmuxd")
	}
	devs, err := List()
	if err != nil {
		t.Fatal(err)
	}
	if len(devs) != 2 || devs[0].ID != 5 || !devs[0].USB || devs[0].Serial != "00008110-001A2B3C4D5E801E" || devs[0].ProductID != 4776 || devs[1].USB {
		t.Fatalf("设备列表不对：%+v", devs)
	}
	c, err := Connect(5, 39274)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if _, err := c.Write([]byte("hello")); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 5)
	if _, err := io.ReadFull(c, buf); err != nil || string(buf) != "hello" {
		t.Fatalf("连接后应是透明的字节流：%q %v", buf, err)
	}
	if _, err := Connect(5, 1234); err != ErrRefused {
		t.Fatalf("没有监听的端口应返回 ErrRefused：%v", err)
	}
}

func TestUnavailable(t *testing.T) {
	t.Setenv("P2D_USBMUXD", "tcp:127.0.0.1:1")
	if Available() {
		t.Fatal("连不上时应返回不可用")
	}
	if _, err := List(); err == nil {
		t.Fatal("应报错")
	}
}
