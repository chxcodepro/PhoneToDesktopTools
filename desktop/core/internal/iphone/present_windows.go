package iphone

import (
	"strings"

	"golang.org/x/sys/windows"
)

// applePresent 插着苹果的 USB 设备：枚举当前在线的 USB 设备，看硬件 ID 里有没有 VID_05AC。
// 没装苹果驱动时 iPhone 也会出现在设备列表里（显示为未知设备或便携设备），所以能用来判断要不要提示安装。
func applePresent() bool {
	set, err := windows.SetupDiGetClassDevsEx(nil, "USB", 0, windows.DIGCF_PRESENT|windows.DIGCF_ALLCLASSES, 0, "")
	if err != nil {
		return false
	}
	defer set.Close()
	for i := 0; ; i++ {
		d, err := set.EnumDeviceInfo(i)
		if err != nil {
			return false // 枚举完了（ERROR_NO_MORE_ITEMS）
		}
		v, err := set.DeviceRegistryProperty(d, windows.SPDRP_HARDWAREID)
		if err != nil {
			continue
		}
		ids, _ := v.([]string)
		for _, id := range ids {
			if strings.Contains(strings.ToUpper(id), "VID_05AC") {
				return true
			}
		}
	}
}
