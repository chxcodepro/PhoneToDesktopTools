//go:build windows

package screen

import "testing"

// 反复截图，检查偶发失败
func TestCaptureRepeated(t *testing.T) {
	Init()
	ds, err := Displays()
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 20; i++ {
		for _, d := range ds {
			img, err := Capture(d.Bounds)
			if err != nil {
				t.Fatalf("第 %d 次截取显示器 %d 失败：%v", i, d.Index, err)
			}
			if img.Bounds().Dx() != d.Width {
				t.Fatalf("尺寸不对")
			}
		}
	}
}
