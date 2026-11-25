package adb

import (
	"testing"

	"p2d/core/internal/adbwire"
)

func TestMergeDevices(t *testing.T) {
	direct := map[string]listed{"A": {serial: "A", state: stDevice}}
	failed := map[string]listed{
		"B": {serial: "B", state: stError, msg: msgBusy},       // adb 服务占着
		"C": {serial: "C", state: stError, msg: "驱动不是 WinUSB"}, // 没有服务管
	}
	srv := []adbwire.ServerDevice{{Serial: "A", State: "offline"}, {Serial: "B", State: "device"}, {Serial: "192.168.1.5:5555", State: "device"}}
	got := map[string]listed{}
	for _, l := range mergeDevices(direct, failed, srv) {
		got[l.serial] = l
	}
	if len(got) != 4 {
		t.Fatalf("%+v", got)
	}
	if got["A"].state != stDevice || got["A"].link != nil {
		t.Fatal("直连上的手机不应经服务")
	}
	if _, ok := got["B"].link.(adbwire.Server); !ok || got["B"].state != "device" {
		t.Fatal("被 adb 服务占着的手机应经服务")
	}
	if got["C"].state != stError || got["C"].msg == "" {
		t.Fatal("打不开又没有服务管的手机应显示原因")
	}
	if transportOf("192.168.1.5:5555") != TransportWiFi {
		t.Fatal("网络设备")
	}
}
