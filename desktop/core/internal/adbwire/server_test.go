package adbwire

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net"
	"strconv"
	"testing"
)

// adb 的提示行（版本不一致时重启服务等）不能当成设备
func TestParseDevicesSkipsNotices(t *testing.T) {
	out := "adb server version (41) doesn't match this client (39); killing...\n" +
		"* daemon started successfully\n" +
		"List of devices attached\n" +
		"3B1F5JE5MS12F371       device product:PJZ110 model:PJZ110 device:OP5D0DL1 transport_id:9\n"
	got := parseDevices(out)
	if len(got) != 1 || got[0].Serial != "3B1F5JE5MS12F371" || got[0].State != "device" || got[0].Model != "PJZ110" {
		t.Fatalf("解析结果 %+v", got)
	}
}

// 模拟 adb 后台服务：列出设备、执行 shell
func TestServer(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	old := ServerAddr
	ServerAddr = ln.Addr().String()
	defer func() { ServerAddr = old }()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				r := bufio.NewReader(c)
				readReq := func() string {
					var l [4]byte
					if _, err := io.ReadFull(r, l[:]); err != nil {
						return ""
					}
					n, _ := strconv.ParseUint(string(l[:]), 16, 16)
					b := make([]byte, n)
					_, _ = io.ReadFull(r, b)
					return string(b)
				}
				switch req := readReq(); req {
				case "host:devices-l":
					list := "ABC device usb:1-2 model:Pixel_8\n"
					fmt.Fprintf(c, "OKAY%04x%s", len(list), list)
				case "host:transport:ABC":
					c.Write([]byte("OKAY"))
					if readReq() == "shell:getprop ro.serialno" {
						c.Write([]byte("OKAYABC\n"))
					}
				default:
					msg := "device not found"
					fmt.Fprintf(c, "FAIL%04x%s", len(msg), msg)
				}
			}(c)
		}
	}()
	ctx := context.Background()
	list, err := ServerDevices(ctx)
	if err != nil || len(list) != 1 || list[0].Model != "Pixel 8" {
		t.Fatalf("%+v %v", list, err)
	}
	out, err := Shell(ctx, Server{Serial: "ABC"}, "getprop ro.serialno")
	if err != nil || out != "ABC" {
		t.Fatalf("%q %v", out, err)
	}
	if _, err := Shell(ctx, Server{Serial: "XYZ"}, "id"); err == nil {
		t.Fatal("不存在的设备应失败")
	}
}

func TestNoServer(t *testing.T) {
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	addr := ln.Addr().String()
	ln.Close()
	old := ServerAddr
	ServerAddr = addr
	defer func() { ServerAddr = old }()
	if _, err := ServerDevices(context.Background()); err != ErrNoServer {
		t.Fatal(err)
	}
}
