//go:build windows

package screen

import (
	"image"
	"testing"
	"time"
)

// TestDXGISource 桌面复制截出来的画面和 GDI 一样大、不是全黑，并给出耗时（没有显卡 / Win7 时跳过）。
func TestDXGISource(t *testing.T) {
	Init()
	ds, err := Displays()
	if err != nil || len(ds) == 0 {
		t.Skip("没有显示器")
	}
	c, err := openDXGI(ds[0].Bounds)
	if err != nil {
		t.Skip("不能用桌面复制：", err)
	}
	defer c.Close()
	var img = waitFrame(t, c)
	if img.Bounds().Dx() != ds[0].Width || img.Bounds().Dy() != ds[0].Height {
		t.Fatalf("尺寸 %v，显示器 %dx%d", img.Bounds(), ds[0].Width, ds[0].Height)
	}
	lit := 0
	for i := 0; i < len(img.Pix); i += 4 * 97 {
		if img.Pix[i]|img.Pix[i+1]|img.Pix[i+2] > 16 {
			lit++
		}
	}
	if lit == 0 {
		t.Fatal("画面全黑")
	}
	gdi, err := Capture(ds[0].Bounds)
	if err != nil {
		t.Fatal(err)
	}
	same := 0
	for i := 0; i < len(img.Pix); i += 4 * 97 {
		if d := int(img.Pix[i]) - int(gdi.Pix[i]); d > -8 && d < 8 {
			same++
		}
	}
	t.Logf("和 GDI 截图相同的采样点 %d%%", same*100/(len(img.Pix)/(4*97)))

	// 连续取 3 秒，看拿到多少帧、每帧多久
	var frames int
	var busy time.Duration
	end := time.Now().Add(3 * time.Second)
	for time.Now().Before(end) {
		t0 := time.Now()
		img, err := c.next(100 * time.Millisecond)
		if err == errDuplicationUnchanged {
			continue
		}
		if err != nil {
			t.Fatal(err)
		}
		_ = img
		frames++
		busy += time.Since(t0)
	}
	if frames > 0 {
		t.Logf("3 秒 %d 帧有变化（%.1f 帧/秒），每帧平均 %v（含等待下一帧）", frames, float64(frames)/3, busy/time.Duration(frames))
	}
}

func waitFrame(t *testing.T, c *dxgiCapturer) *image.RGBA {
	for i := 0; i < 20; i++ { // 最多等 4 秒
		img, err := c.next(200 * time.Millisecond)
		if err == nil {
			return img
		}
		if err != errDuplicationUnchanged {
			t.Fatal(err)
		}
	}
	t.Skip("画面 4 秒没有变化，桌面复制没有给出画面")
	return nil
}
