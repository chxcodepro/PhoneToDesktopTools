package blank

import (
	"errors"
	"fmt"
	"runtime"
	"sync"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"

	"p2d/core/internal/screen"
)

var (
	user32                       = windows.NewLazySystemDLL("user32.dll")
	gdi32                        = windows.NewLazySystemDLL("gdi32.dll")
	procGetModuleHandleW         = windows.NewLazySystemDLL("kernel32.dll").NewProc("GetModuleHandleW")
	procRegisterClassExW         = user32.NewProc("RegisterClassExW")
	procCreateWindowExW          = user32.NewProc("CreateWindowExW")
	procDefWindowProcW           = user32.NewProc("DefWindowProcW")
	procDestroyWindow            = user32.NewProc("DestroyWindow")
	procShowWindow               = user32.NewProc("ShowWindow")
	procSetWindowPos             = user32.NewProc("SetWindowPos")
	procSetLayeredWindowAttrs    = user32.NewProc("SetLayeredWindowAttributes")
	procSetWindowDisplayAffinity = user32.NewProc("SetWindowDisplayAffinity")
	procGetMessageW              = user32.NewProc("GetMessageW")
	procTranslateMessage         = user32.NewProc("TranslateMessage")
	procDispatchMessageW         = user32.NewProc("DispatchMessageW")
	procPostThreadMessageW       = user32.NewProc("PostThreadMessageW")
	procSetTimer                 = user32.NewProc("SetTimer")
	procBeginPaint               = user32.NewProc("BeginPaint")
	procEndPaint                 = user32.NewProc("EndPaint")
	procFillRect                 = user32.NewProc("FillRect")
	procGetClientRect            = user32.NewProc("GetClientRect")
	procDrawTextW                = user32.NewProc("DrawTextW")
	procGetStockObject           = gdi32.NewProc("GetStockObject")
	procCreateFontW              = gdi32.NewProc("CreateFontW")
	procSelectObject             = gdi32.NewProc("SelectObject")
	procSetTextColor             = gdi32.NewProc("SetTextColor")
	procSetBkMode                = gdi32.NewProc("SetBkMode")
)

const (
	wsPopup           = 0x80000000
	wsExTopmost       = 0x00000008
	wsExToolWindow    = 0x00000080
	wsExLayered       = 0x00080000
	wsExTransparent   = 0x00000020
	wsExNoActivate    = 0x08000000
	lwaAlpha          = 0x2
	wdaExcludeCapture = 0x11
	swShowNoActivate  = 4
	swpNoSize         = 0x0001
	swpNoMove         = 0x0002
	swpNoActivate     = 0x0010
	wmPaint           = 0x000F
	wmTimer           = 0x0113
	wmMouseActivate   = 0x0021
	wmQuit            = 0x0012
	maNoActivate      = 3
	blackBrush        = 4
	transparentBk     = 1
	dtCenter          = 0x1
	dtSingleLine      = 0x20
	dtVCenter         = 0x4
	dtNoPrefix        = 0x800
	hwndTopmost       = ^uintptr(0) // (HWND)-1
	// 每隔这么久把黑屏窗口重新提到最前：别的置顶窗口（右键菜单、任务管理器等）弹出来后也会被盖住
	raiseMs = 400
	// 至少要 Windows 10 2004（内部版本 19041）：WDA_EXCLUDEFROMCAPTURE 从这个版本起才真正把窗口排除在截屏外
	minBuild = 19041
)

type rect struct{ Left, Top, Right, Bottom int32 }

type paintStruct struct {
	Hdc         uintptr
	FErase      int32
	RcPaint     rect
	FRestore    int32
	FIncUpdate  int32
	RgbReserved [32]byte
}

type wndClassEx struct {
	Size       uint32
	Style      uint32
	WndProc    uintptr
	ClsExtra   int32
	WndExtra   int32
	Instance   windows.Handle
	Icon       windows.Handle
	Cursor     windows.Handle
	Background windows.Handle
	MenuName   *uint16
	ClassName  *uint16
	IconSm     windows.Handle
}

type msg struct {
	Hwnd    uintptr
	Message uint32
	WParam  uintptr
	LParam  uintptr
	Time    uint32
	Pt      struct{ X, Y int32 }
}

var (
	mu       sync.Mutex
	running  bool
	threadID uint32
	done     chan struct{}

	classOnce sync.Once
	classErr  error
	className = windows.StringToUTF16Ptr("P2DBlankScreen")
	font      uintptr
)

// Supported 这个系统能不能黑屏，不能时返回原因
func Supported() error {
	v := windows.RtlGetVersion()
	if v.MajorVersion < 10 || v.BuildNumber < minBuild {
		return fmt.Errorf("黑屏需要 Windows 10 2004 及以上（这台电脑是 %d.%d.%d）：更早的系统上，黑屏会连手机上看到的画面一起挡住",
			v.MajorVersion, v.MinorVersion, v.BuildNumber)
	}
	return nil
}

// On 是否开着黑屏
func On() bool {
	mu.Lock()
	defer mu.Unlock()
	return running
}

// Show 打开黑屏（已经开着时什么也不做）
func Show() error {
	if err := Supported(); err != nil {
		return err
	}
	mu.Lock()
	defer mu.Unlock()
	if running {
		return nil
	}
	ready := make(chan error, 1)
	d := make(chan struct{})
	go loop(ready, d)
	if err := <-ready; err != nil {
		return err
	}
	running, done = true, d
	return nil
}

// Hide 关闭黑屏，等窗口都关掉再返回
func Hide() {
	mu.Lock()
	defer mu.Unlock()
	if !running {
		return
	}
	procPostThreadMessageW.Call(uintptr(threadID), wmQuit, 0, 0)
	<-done
	running = false
}

// loop 在一个固定的系统线程上建窗口、跑消息循环（窗口只能由创建它的线程处理消息）
func loop(ready chan<- error, done chan<- struct{}) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	defer close(done)
	wins, err := createWindows()
	if err != nil {
		for _, h := range wins {
			procDestroyWindow.Call(h)
		}
		ready <- err
		return
	}
	threadID = windows.GetCurrentThreadId()
	ready <- nil
	var m msg
	for {
		r, _, _ := procGetMessageW.Call(uintptr(unsafe.Pointer(&m)), 0, 0, 0)
		if int32(r) <= 0 { // WM_QUIT 或出错
			break
		}
		procTranslateMessage.Call(uintptr(unsafe.Pointer(&m)))
		procDispatchMessageW.Call(uintptr(unsafe.Pointer(&m)))
	}
	for _, h := range wins {
		procDestroyWindow.Call(h)
	}
}

func registerClass() error {
	classOnce.Do(func() {
		inst, _, _ := procGetModuleHandleW.Call(0)
		wc := wndClassEx{
			WndProc:    syscall.NewCallback(wndProc),
			Instance:   windows.Handle(inst),
			Background: 0, // 自己在 WM_PAINT 里画
			ClassName:  className,
		}
		wc.Size = uint32(unsafe.Sizeof(wc))
		if r, _, e := procRegisterClassExW.Call(uintptr(unsafe.Pointer(&wc))); r == 0 {
			classErr = fmt.Errorf("注册窗口类失败：%v", e)
		}
		// 微软雅黑，字号按 1080 高的屏幕取 26 像素左右；系统没有这个字体时 GDI 会自动换一个
		face := windows.StringToUTF16Ptr("Microsoft YaHei")
		font, _, _ = procCreateFontW.Call(uintptr(-26&0xFFFFFFFF), 0, 0, 0, 400, 0, 0, 0, 1, 0, 0, 5, 0, uintptr(unsafe.Pointer(face)))
	})
	return classErr
}

// createWindows 每个显示器一个黑屏窗口。坐标是物理像素（Core 启动时已声明感知 DPI）
func createWindows() ([]uintptr, error) {
	if err := registerClass(); err != nil {
		return nil, err
	}
	ds, err := screen.Displays()
	if err != nil {
		return nil, err
	}
	title := windows.StringToUTF16Ptr("P2D 黑屏")
	var wins []uintptr
	for _, d := range ds {
		h, _, e := procCreateWindowExW.Call(
			wsExTopmost|wsExToolWindow|wsExLayered|wsExTransparent|wsExNoActivate,
			uintptr(unsafe.Pointer(className)), uintptr(unsafe.Pointer(title)), wsPopup,
			uintptr(int32(d.X)), uintptr(int32(d.Y)), uintptr(int32(d.Width)), uintptr(int32(d.Height)),
			0, 0, 0, 0)
		if h == 0 {
			return wins, fmt.Errorf("创建黑屏窗口失败：%v", e)
		}
		wins = append(wins, h)
		// 分层窗口 + WS_EX_TRANSPARENT：完全不透明，但鼠标点击穿透到下面的程序（手机上的点击照常生效）
		procSetLayeredWindowAttrs.Call(h, 0, 255, lwaAlpha)
		if r, _, e := procSetWindowDisplayAffinity.Call(h, wdaExcludeCapture); r == 0 {
			return wins, fmt.Errorf("系统不支持把黑屏排除在截屏外：%v", e)
		}
		procShowWindow.Call(h, swShowNoActivate)
		procSetTimer.Call(h, 1, raiseMs, 0)
	}
	if len(wins) == 0 {
		return nil, errors.New("没有找到显示器")
	}
	return wins, nil
}

func wndProc(hwnd, m, wparam, lparam uintptr) uintptr {
	switch uint32(m) {
	case wmPaint:
		paint(hwnd)
		return 0
	case wmTimer:
		procSetWindowPos.Call(hwnd, hwndTopmost, 0, 0, 0, 0, swpNoMove|swpNoSize|swpNoActivate)
		return 0
	case wmMouseActivate:
		return maNoActivate
	}
	r, _, _ := procDefWindowProcW.Call(hwnd, m, wparam, lparam)
	return r
}

// paint 涂黑，中间用灰色小字写两行说明
func paint(hwnd uintptr) {
	var ps paintStruct
	hdc, _, _ := procBeginPaint.Call(hwnd, uintptr(unsafe.Pointer(&ps)))
	defer procEndPaint.Call(hwnd, uintptr(unsafe.Pointer(&ps)))
	var rc rect
	procGetClientRect.Call(hwnd, uintptr(unsafe.Pointer(&rc)))
	brush, _, _ := procGetStockObject.Call(blackBrush)
	procFillRect.Call(hdc, uintptr(unsafe.Pointer(&rc)), brush)
	if font != 0 {
		procSelectObject.Call(hdc, font)
	}
	procSetBkMode.Call(hdc, transparentBk)
	procSetTextColor.Call(hdc, 0x808080)
	mid := (rc.Top + rc.Bottom) / 2
	for i, line := range Text {
		r := rect{Left: rc.Left, Right: rc.Right, Top: mid - 40 + int32(i)*44, Bottom: mid + int32(i)*44}
		s := windows.StringToUTF16(line)
		procDrawTextW.Call(hdc, uintptr(unsafe.Pointer(&s[0])), uintptr(len(s)-1), uintptr(unsafe.Pointer(&r)), dtCenter|dtSingleLine|dtVCenter|dtNoPrefix)
	}
}
