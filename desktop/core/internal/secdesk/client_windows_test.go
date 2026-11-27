//go:build windows

package secdesk

import (
	"image/png"
	"os"
	"testing"
	"time"

	"p2d/core/internal/input"
	"p2d/core/internal/screen"
)

// 手动测试（要先开启锁屏远程支持）：P2D_SECDESK_TEST=<截图保存路径>
func TestHelperManual(t *testing.T) {
	out := os.Getenv("P2D_SECDESK_TEST")
	if out == "" {
		t.Skip("设置 P2D_SECDESK_TEST=<截图保存路径> 手动测试")
	}
	screen.Init()
	if !cl.ready() {
		_, why := cl.connected()
		t.Fatalf("连不上锁屏助手：%s", why)
	}
	ds, err := screen.Displays()
	if err != nil {
		t.Fatal(err)
	}
	begin := time.Now()
	n := 0
	var last []byte
	for time.Since(begin) < 2*time.Second {
		img, err := secureCapture(ds[0].Bounds)
		if err != nil {
			t.Fatalf("经助手截屏失败：%v", err)
		}
		last = img.Pix
		n++
		if n == 1 {
			f, _ := os.Create(out)
			_ = png.Encode(f, img)
			f.Close()
		}
	}
	t.Logf("经助手截屏 %d×%d：2 秒 %d 张（%.1f 张/秒），%d 字节", ds[0].Width, ds[0].Height, n, float64(n)/2, len(last))
	x, y, ok := secureCursor()
	t.Logf("鼠标位置 %d,%d %v", x, y, ok)
	if !ok {
		t.Fatal("读不到鼠标位置")
	}
	// 鼠标移到原位（不改变什么），检查键鼠请求能走通
	if _, _, err := cl.call(request{Op: "input", Input: &input.Op{Kind: "move", X: x, Y: y}}); err != nil {
		t.Fatalf("经助手移动鼠标失败：%v", err)
	}
	t.Logf("状态：%+v", Status())
}
