//go:build windows

package screen

import (
	"runtime"
	"strings"
	"syscall"
	"unsafe"
)

// 锁屏检测、唤醒显示器、推流期间不息屏。
//
// Windows 锁屏、登录界面和 UAC 确认窗口在单独的安全桌面（Winlogon）上，以普通用户身份运行的程序
// 截不到它的画面（BitBlt 失败、桌面复制 DuplicateOutput 返回 E_ACCESSDENIED），也发不进键盘鼠标。

var (
	kernel32                    = syscall.NewLazyDLL("kernel32.dll")
	procSetThreadExecutionState = kernel32.NewProc("SetThreadExecutionState")
	procOpenInputDesktop        = user32.NewProc("OpenInputDesktop")
	procCloseDesktop            = user32.NewProc("CloseDesktop")
	procGetUserObjectInfoW      = user32.NewProc("GetUserObjectInformationW")
	procSendInputScreen         = user32.NewProc("SendInput")
)

const (
	desktopReadObjects = 0x0001
	uoiName            = 2

	esSystemRequired  = 0x00000001
	esDisplayRequired = 0x00000002
	esContinuous      = 0x80000000

	mouseeventfMove = 0x0001
)

// Locked 当前接收键盘鼠标的桌面不是普通桌面（锁屏、登录界面、UAC 确认窗口）。
func Locked() bool {
	h, _, _ := procOpenInputDesktop.Call(0, 0, desktopReadObjects)
	if h == 0 {
		return true // 打不开：输入桌面是安全桌面
	}
	defer procCloseDesktop.Call(h)
	var buf [64]uint16
	var n uint32
	r, _, _ := procGetUserObjectInfoW.Call(h, uoiName, uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)*2), uintptr(unsafe.Pointer(&n)))
	if r == 0 {
		return false
	}
	return !strings.EqualFold(syscall.UTF16ToString(buf[:]), "Default")
}

// 与 C 的 INPUT 结构体（鼠标）布局一致
type wakeInput struct {
	Type        uint32
	Dx, Dy      int32
	MouseData   uint32
	DwFlags     uint32
	Time        uint32
	DwExtraInfo uintptr
}

// WakeDisplay 显示器因为闲置关了时把它唤醒：鼠标相对移动 1 像素再移回来（鼠标位置不变）。
// 锁屏时发不进去（也看不到锁屏画面），什么都不做。
func WakeDisplay() {
	if Locked() {
		return
	}
	in := [2]wakeInput{
		{DwFlags: mouseeventfMove, Dx: 1},
		{DwFlags: mouseeventfMove, Dx: -1},
	}
	procSendInputScreen.Call(2, uintptr(unsafe.Pointer(&in[0])), unsafe.Sizeof(in[0]))
}

// KeepAwake 推流期间不让电脑因为闲置而息屏、睡眠（息屏后很多电脑会接着锁屏），返回恢复函数。
// SetThreadExecutionState 的持续状态跟着调用的线程走，所以在一个固定的系统线程上设置，结束时在同一个线程上清掉。
func KeepAwake() func() {
	stop := make(chan struct{})
	done := make(chan struct{})
	go func() {
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		procSetThreadExecutionState.Call(esContinuous | esSystemRequired | esDisplayRequired)
		<-stop
		procSetThreadExecutionState.Call(esContinuous)
		close(done)
	}()
	return func() {
		close(stop)
		<-done
	}
}
