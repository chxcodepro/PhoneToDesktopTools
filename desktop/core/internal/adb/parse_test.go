package adb

import "testing"

// adb 的提示行（版本不一致时重启服务等）不能当成设备
func TestParseDevicesSkipsNotices(t *testing.T) {
	out := "adb server version (41) doesn't match this client (39); killing...\n" +
		"* daemon started successfully\n" +
		"List of devices attached\n" +
		"3B1F5JE5MS12F371       device product:PJZ110 model:PJZ110 device:OP5D0DL1 transport_id:9\n"
	got := parseDevices(out)
	if len(got) != 1 || got[0].serial != "3B1F5JE5MS12F371" || got[0].state != "device" || got[0].model != "PJZ110" {
		t.Fatalf("解析结果 %+v", got)
	}
}
