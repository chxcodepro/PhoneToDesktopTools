package usbdriver

import "testing"

// 在本机真实枚举一次 USB 设备：不应出错；插着已装好驱动的手机时结果为空
func TestScan(t *testing.T) {
	list, err := scan()
	if err != nil {
		t.Fatal(err)
	}
	for _, d := range list {
		t.Logf("缺驱动：%s（%s）", d.Name, d.InstanceID)
	}
}
