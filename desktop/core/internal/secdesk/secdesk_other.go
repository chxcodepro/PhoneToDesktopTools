//go:build !windows

package secdesk

// Supported 这个系统支持锁屏远程支持（只有 Windows）
const Supported = false

// Enable 让截屏和键鼠操作在锁屏时转给锁屏助手（只有 Windows）。
func Enable() {}

// Status 给电脑端界面看的状态（不支持时为 nil）。
func Status() any { return nil }

// Install 以管理员身份开启（只有 Windows）。
func Install() error { return nil }

// Uninstall 以管理员身份关闭（只有 Windows）。
func Uninstall() error { return nil }

// RunCommand 内部命令（服务、助手、提权后的开启 / 关闭），只有 Windows 有。
func RunCommand(args []string) (int, bool) { return 0, false }
