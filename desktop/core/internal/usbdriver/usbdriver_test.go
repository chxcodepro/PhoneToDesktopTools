package usbdriver

import (
	"strings"
	"testing"
)

func TestINF(t *testing.T) {
	inf := INF()
	for _, want := range []string{
		"[Version]", `Signature   = "$Windows NT$"`, "NTx86", "NTamd64",
		`USB_Install, USB\Class_FF&SubClass_42&Prot_01`,
		"Include = winusb.inf", "{F72FE0D4-CBCB-407d-8814-9ED673D0DD6B}",
	} {
		if !strings.Contains(inf, want) {
			t.Errorf("INF 缺少 %q", want)
		}
	}
	if strings.Contains(inf, "CatalogFile") {
		t.Error("没有签名文件，不应声明 CatalogFile")
	}
	for i, r := range inf {
		if r > 0x7E || (r < 0x20 && r != '\r' && r != '\n') {
			t.Fatalf("INF 只能含 ASCII 字符，第 %d 个字符是 %q", i, r)
		}
	}
	if strings.Count(inf, "\n") != strings.Count(inf, "\r\n") {
		t.Error("INF 应使用 Windows 换行")
	}
}

func TestHasADBInterface(t *testing.T) {
	if !hasADBInterface([]string{`USB\Class_ff&SubClass_42&Prot_01`, `USB\Class_ff&SubClass_42`, `USB\Class_ff`}) {
		t.Error("大小写不同也应识别为 ADB 接口")
	}
	if hasADBInterface([]string{`USB\Class_06&SubClass_01&Prot_01`, `USB\Class_ff&SubClass_42&Prot_03`}) {
		t.Error("MTP 接口、fastboot 等不是 ADB 接口")
	}
}
