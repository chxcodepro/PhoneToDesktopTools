package adbwire

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"p2d/core/internal/usbio"
)

// 真机：P2D_USB_TEST=1 时经 USB 直连插着的手机，执行几条命令（电脑上不能有 adb 服务占着手机）
func TestRealDevice(t *testing.T) {
	if os.Getenv("P2D_USB_TEST") == "" {
		t.Skip("设置 P2D_USB_TEST=1 时运行")
	}
	list, err := usbio.ADBDevices()
	if err != nil || len(list) == 0 {
		t.Fatalf("没有找到手机：%v", err)
	}
	p, err := list[0].Open()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	start := time.Now()
	c, err := Handshake(ctx, p, NewKeys(t.TempDir(), "test"), func(s State) { t.Logf("状态：%s", s) })
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	t.Logf("握手 %v，型号 %s，单条消息上限 %d", time.Since(start), c.Model(), c.maxData)
	for _, cmd := range []string{"getprop ro.serialno", "getprop ro.product.marketname", "pm path com.p2d.mobile", "echo 'a&b'"} {
		out, err := Shell(ctx, c, cmd)
		t.Logf("%s → %q %v", cmd, out, err)
	}
	// 大量输出（P2D_N 字节，默认 3 MB）
	n := os.Getenv("P2D_N")
	if n == "" {
		n = "3000000"
	}
	start = time.Now()
	out, err := Shell(ctx, c, "yes | head -c "+n)
	t.Logf("大量输出：%d 字节，%v，%v", len(out), time.Since(start), err)
	if err != nil || len(out) < 1000 {
		t.Fatal("大量输出不完整")
	}
	if apk := os.Getenv("P2D_APK"); apk != "" {
		start = time.Now()
		out, err := Install(ctx, c, apk)
		t.Logf("安装 → %q %v（%v）", out, err, time.Since(start))
	}
	port := 39999
	if err := Reverse(ctx, c, port); err != nil {
		t.Fatal(err)
	}
	l, err := ReverseList(ctx, c)
	t.Logf("reverse list：%q %v", l, err)
	if !strings.Contains(l, fmt.Sprintf("tcp:%d", port)) {
		t.Fatal("没有建立反向转发")
	}
	if err := ReverseRemove(ctx, c, port); err != nil {
		t.Fatal(err)
	}
}
