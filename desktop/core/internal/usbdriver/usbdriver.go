// Package usbdriver 安卓手机 ADB 接口的 USB 驱动：检测缺驱动的手机、安装驱动（仅 Windows）。
//
// Win7 不会自动给手机的 ADB 接口装驱动，Google 的 USB 驱动又不允许随软件分发，所以这里自带一份
// 驱动描述文件（INF）：不含任何驱动程序文件，只让系统自带的 WinUSB 接管 ADB 接口。
// 它按 ADB 接口的通用标识（USB\Class_FF&SubClass_42&Prot_01）匹配，所有品牌的手机都适用。
// INF 没有微软签名，安装时 Windows 会提示「无法验证此驱动程序软件的发布者」，用户点「始终安装」即可。
package usbdriver

import "strings"

// ADBCompatibleID 安卓 ADB 接口的兼容标识（接口类 0xFF、子类 0x42、协议 0x01）
const ADBCompatibleID = `USB\Class_FF&SubClass_42&Prot_01`

// Device 缺驱动的手机 ADB 接口
type Device struct {
	Name       string `json:"name"`
	InstanceID string `json:"instanceId"`
}

// infLines 驱动描述文件。ClassGuid 和设备接口 GUID 与 Google USB 驱动相同，adb（AdbWinApi.dll）靠接口 GUID 找到手机。
var infLines = []string{
	`; p2d：安卓手机 ADB 接口驱动，使用系统自带的 WinUSB，不含驱动程序文件`,
	`[Version]`,
	`Signature   = "$Windows NT$"`,
	`Class       = AndroidUsbDeviceClass`,
	`ClassGuid   = {3F966BD9-FA04-4ec5-991C-D326973B5128}`,
	`Provider    = %ProviderName%`,
	`DriverVer   = 11/23/2026,1.0.0.0`,
	``,
	`[ClassInstall32]`,
	`AddReg = AndroidUsbClassReg`,
	``,
	`[AndroidUsbClassReg]`,
	`HKR,,,0,%ClassName%`,
	`HKR,,Icon,,-1`,
	``,
	`[Manufacturer]`,
	`%ProviderName% = P2D, NTx86, NTamd64`,
	``,
	`[P2D.NTx86]`,
	`%AdbInterface% = USB_Install, ` + ADBCompatibleID,
	``,
	`[P2D.NTamd64]`,
	`%AdbInterface% = USB_Install, ` + ADBCompatibleID,
	``,
	`[USB_Install]`,
	`Include = winusb.inf`,
	`Needs   = WINUSB.NT`,
	``,
	`[USB_Install.Services]`,
	`Include    = winusb.inf`,
	`AddService = WinUSB,0x00000002,WinUSB_ServiceInstall`,
	``,
	`[WinUSB_ServiceInstall]`,
	`DisplayName   = %WinUSB_SvcDesc%`,
	`ServiceType   = 1`,
	`StartType     = 3`,
	`ErrorControl  = 1`,
	`ServiceBinary = %12%\WinUSB.sys`,
	``,
	`[USB_Install.HW]`,
	`AddReg = Dev_AddReg`,
	``,
	`[Dev_AddReg]`,
	`HKR,,DeviceInterfaceGUIDs,0x10000,"{F72FE0D4-CBCB-407d-8814-9ED673D0DD6B}"`,
	``,
	`[Strings]`,
	`ProviderName   = "PhoneToDesktop"`,
	`AdbInterface   = "Android ADB Interface"`,
	`ClassName      = "Android Device"`,
	`WinUSB_SvcDesc = "WinUSB Driver"`,
}

// INF 驱动描述文件内容：Windows 换行；注释行不写进文件（INF 按 ANSI 读取，中文会乱码）
func INF() string {
	var b strings.Builder
	for _, l := range infLines {
		if strings.HasPrefix(l, ";") {
			continue
		}
		b.WriteString(l)
		b.WriteString("\r\n")
	}
	return b.String()
}

// hasADBInterface 兼容标识列表里有没有 ADB 接口
func hasADBInterface(ids []string) bool {
	for _, id := range ids {
		if strings.EqualFold(strings.TrimSpace(id), ADBCompatibleID) {
			return true
		}
	}
	return false
}
