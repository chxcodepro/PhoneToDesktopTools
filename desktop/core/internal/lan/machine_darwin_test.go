//go:build darwin

package lan

import "testing"

func TestParsePlatformUUID(t *testing.T) {
	s := `+-o MacBookPro18,3  <class IOPlatformExpertDevice, id 0x100000110, registered>
    {
      "IOPlatformSerialNumber" = "C02XXXXXXX"
      "IOPlatformUUID" = "5B1C2A3D-1E2F-4A5B-9C8D-7E6F5A4B3C2D"
    }`
	if got := parsePlatformUUID(s); got != "5B1C2A3D-1E2F-4A5B-9C8D-7E6F5A4B3C2D" {
		t.Fatalf("解析结果 %q", got)
	}
	if parsePlatformUUID("没有") != "" {
		t.Fatal("取不到时应为空")
	}
}
