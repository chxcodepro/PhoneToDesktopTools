//go:build !windows

package screen

// Locked 锁屏检测：目前只在 Windows 上做
func Locked() bool { return false }

// WakeDisplay 唤醒显示器：目前只在 Windows 上做
func WakeDisplay() {}

// KeepAwake 推流期间不息屏：目前只在 Windows 上做
func KeepAwake() func() { return func() {} }
