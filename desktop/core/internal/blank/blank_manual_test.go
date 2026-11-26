//go:build windows

package blank

import (
	"image"
	"os"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"

	"p2d/core/internal/screen"
)

// 在真实桌面上打开黑屏几秒（屏幕会真的变黑）：P2D_BLANK_TEST=1 go test ./internal/blank/ -run Manual -v
// 检查：黑屏窗口显示着、设置了截屏排除；黑屏期间截到的画面和打开前差不多（不是黑的）。
func TestManualBlank(t *testing.T) {
	if os.Getenv("P2D_BLANK_TEST") == "" {
		t.Skip("会让屏幕真的变黑，设置 P2D_BLANK_TEST=1 才运行")
	}
	if err := Supported(); err != nil {
		t.Skip(err)
	}
	screen.Init()
	ds, err := screen.Displays()
	if err != nil {
		t.Fatal(err)
	}
	r := ds[0].Bounds
	before := brightness(t, r)

	if err := Show(); err != nil {
		t.Fatal(err)
	}
	time.Sleep(800 * time.Millisecond) // 等桌面合成生效
	find := user32.NewProc("FindWindowW")
	visible := user32.NewProc("IsWindowVisible")
	affinity := user32.NewProc("GetWindowDisplayAffinity")
	h, _, _ := find.Call(uintptr(unsafe.Pointer(className)), 0)
	var aff uint32
	if h != 0 {
		affinity.Call(h, uintptr(unsafe.Pointer(&aff)))
	}
	vis, _, _ := visible.Call(h)
	during := brightness(t, r)
	Hide()
	time.Sleep(300 * time.Millisecond)
	h2, _, _ := find.Call(uintptr(unsafe.Pointer(className)), 0)

	t.Logf("黑屏窗口 %#x 可见 %v 截屏排除标志 %#x；平均亮度：打开前 %.1f，黑屏期间截图 %.1f；关闭后窗口 %#x", h, vis != 0, aff, before, during, h2)
	if h == 0 || vis == 0 {
		t.Fatal("黑屏窗口没有显示")
	}
	if aff != wdaExcludeCapture {
		t.Fatalf("截屏排除标志不对：%#x", aff)
	}
	if during < before*0.5 || during < 5 {
		t.Fatalf("黑屏期间截到的画面变暗了（%.1f → %.1f），黑屏没有被排除在截屏外", before, during)
	}
	if h2 != 0 {
		t.Fatal("关闭后黑屏窗口还在")
	}
	_ = windows.Handle(0)
}

func brightness(t *testing.T, r image.Rectangle) float64 {
	img, err := screen.Capture(r)
	if err != nil {
		t.Fatal(err)
	}
	var sum, n float64
	for y := 0; y < img.Rect.Dy(); y += 7 {
		for x := 0; x < img.Rect.Dx(); x += 7 {
			c := img.RGBAAt(x, y)
			sum += float64(c.R) + float64(c.G) + float64(c.B)
			n += 3
		}
	}
	return sum / n
}
