//go:build windows

package screen

import (
	"errors"
	"fmt"
	"image"
	"runtime"
	"sort"
	"sync"
	"syscall"
	"unsafe"
)

var (
	user32 = syscall.NewLazyDLL("user32.dll")
	gdi32  = syscall.NewLazyDLL("gdi32.dll")

	procSetProcessDPIAware   = user32.NewProc("SetProcessDPIAware")
	procEnumDisplayMonitors  = user32.NewProc("EnumDisplayMonitors")
	procGetMonitorInfoW      = user32.NewProc("GetMonitorInfoW")
	procGetDC                = user32.NewProc("GetDC")
	procReleaseDC            = user32.NewProc("ReleaseDC")
	procGetSystemMetrics     = user32.NewProc("GetSystemMetrics")
	procCreateCompatibleDC   = gdi32.NewProc("CreateCompatibleDC")
	procCreateDIBSection     = gdi32.NewProc("CreateDIBSection")
	procGdiFlush             = gdi32.NewProc("GdiFlush")
	procSelectObject         = gdi32.NewProc("SelectObject")
	procBitBlt               = gdi32.NewProc("BitBlt")
	procDeleteObject         = gdi32.NewProc("DeleteObject")
	procDeleteDC             = gdi32.NewProc("DeleteDC")
	enumMonitorsCallbackOnce sync.Once
	enumMonitorsCallback     uintptr
	enumMu                   sync.Mutex
	enumResult               []Display
)

type rect struct{ Left, Top, Right, Bottom int32 }

type monitorInfo struct {
	CbSize    uint32
	RcMonitor rect
	RcWork    rect
	DwFlags   uint32
}

type bitmapInfoHeader struct {
	BiSize          uint32
	BiWidth         int32
	BiHeight        int32
	BiPlanes        uint16
	BiBitCount      uint16
	BiCompression   uint32
	BiSizeImage     uint32
	BiXPelsPerMeter int32
	BiYPelsPerMeter int32
	BiClrUsed       uint32
	BiClrImportant  uint32
}

const (
	srcCopy    = 0x00CC0020
	captureBlt = 0x40000000
)

// Init 声明进程感知 DPI，使截图和鼠标坐标都是物理像素（Win7 缩放 125%/150% 时很重要）。
func Init() {
	if procSetProcessDPIAware.Find() == nil {
		procSetProcessDPIAware.Call()
	}
}

func monitorEnumProc(hMonitor, hdc, lprc, lParam uintptr) uintptr {
	var mi monitorInfo
	mi.CbSize = uint32(unsafe.Sizeof(mi))
	r, _, _ := procGetMonitorInfoW.Call(hMonitor, uintptr(unsafe.Pointer(&mi)))
	if r != 0 {
		rc := image.Rect(int(mi.RcMonitor.Left), int(mi.RcMonitor.Top), int(mi.RcMonitor.Right), int(mi.RcMonitor.Bottom))
		enumResult = append(enumResult, newDisplay(0, rc, mi.DwFlags&1 != 0))
	}
	return 1
}

// Displays 返回所有显示器，主显示器排在第 0 个。
func Displays() ([]Display, error) {
	enumMonitorsCallbackOnce.Do(func() { enumMonitorsCallback = syscall.NewCallback(monitorEnumProc) })
	enumMu.Lock()
	defer enumMu.Unlock()
	enumResult = nil
	procEnumDisplayMonitors.Call(0, 0, enumMonitorsCallback, 0)
	out := append([]Display(nil), enumResult...)
	if len(out) == 0 {
		w, _, _ := procGetSystemMetrics.Call(0) // SM_CXSCREEN
		h, _, _ := procGetSystemMetrics.Call(1) // SM_CYSCREEN
		if w == 0 || h == 0 {
			return nil, errors.New("无法获取显示器信息")
		}
		out = []Display{newDisplay(0, image.Rect(0, 0, int(w), int(h)), true)}
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Primary != out[j].Primary {
			return out[i].Primary
		}
		return out[i].Bounds.Min.X < out[j].Bounds.Min.X
	})
	for i := range out {
		out[i].Index = i
	}
	return out, nil
}

// Capture 截取虚拟桌面中的一块区域。
func Capture(r image.Rectangle) (*image.RGBA, error) {
	w, h := r.Dx(), r.Dy()
	if w <= 0 || h <= 0 {
		return nil, errors.New("截图区域为空")
	}
	// GDI 调用固定在同一个系统线程上完成
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	hdcScreen, _, _ := procGetDC.Call(0)
	if hdcScreen == 0 {
		return nil, errors.New("GetDC 失败（可能处于锁屏或远程桌面断开状态）")
	}
	defer procReleaseDC.Call(0, hdcScreen)
	hdcMem, _, _ := procCreateCompatibleDC.Call(hdcScreen)
	if hdcMem == 0 {
		return nil, errors.New("CreateCompatibleDC 失败")
	}
	defer procDeleteDC.Call(hdcMem)
	// 用 DIB Section 让 GDI 自己分配像素内存（直接把大块 Go 内存交给 GetDIBits 会失败）
	hdr := bitmapInfoHeader{BiWidth: int32(w), BiHeight: -int32(h), BiPlanes: 1, BiBitCount: 32}
	hdr.BiSize = uint32(unsafe.Sizeof(hdr))
	var bits unsafe.Pointer
	hbm, _, lastErr := procCreateDIBSection.Call(hdcScreen, uintptr(unsafe.Pointer(&hdr)), 0,
		uintptr(unsafe.Pointer(&bits)), 0, 0)
	if hbm == 0 || bits == nil {
		return nil, fmt.Errorf("CreateDIBSection 失败：%v", lastErr)
	}
	defer procDeleteObject.Call(hbm)
	old, _, _ := procSelectObject.Call(hdcMem, hbm)
	defer procSelectObject.Call(hdcMem, old)

	ok, _, _ := procBitBlt.Call(hdcMem, 0, 0, uintptr(w), uintptr(h), hdcScreen,
		uintptr(int32(r.Min.X)), uintptr(int32(r.Min.Y)), srcCopy|captureBlt)
	if ok == 0 {
		return nil, errors.New("BitBlt 失败（可能处于锁屏或安全桌面）")
	}
	procGdiFlush.Call()

	img := image.NewRGBA(image.Rect(0, 0, w, h))
	copy(img.Pix, unsafe.Slice((*byte)(bits), w*h*4))
	// BGRA → RGBA
	p := img.Pix
	for i := 0; i+3 < len(p); i += 4 {
		p[i], p[i+2], p[i+3] = p[i+2], p[i], 255
	}
	return img, nil
}

var procGetCursorPos = user32.NewProc("GetCursorPos")

// CursorPos 鼠标在虚拟桌面中的位置。
func CursorPos() (x, y int, ok bool) {
	var pt struct{ X, Y int32 }
	r, _, _ := procGetCursorPos.Call(uintptr(unsafe.Pointer(&pt)))
	return int(pt.X), int(pt.Y), r != 0
}
