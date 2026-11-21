//go:build windows

package screen

import "testing"

// BenchmarkCaptureEncode 测量远程桌面每一帧的耗时：截取主显示器 + 缩放到 1280 宽 + JPEG 编码。
func BenchmarkCaptureEncode(b *testing.B) {
	ds, err := Displays()
	if err != nil || len(ds) == 0 {
		b.Skip("没有显示器")
	}
	for i := 0; i < b.N; i++ {
		img, err := Capture(ds[0].Bounds)
		if err != nil {
			b.Fatal(err)
		}
		if _, err := Encode(img, 1280, 60); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkCaptureOnly(b *testing.B) {
	ds, _ := Displays()
	if len(ds) == 0 {
		b.Skip("没有显示器")
	}
	for i := 0; i < b.N; i++ {
		if _, err := Capture(ds[0].Bounds); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkDownscale(b *testing.B) {
	ds, _ := Displays()
	if len(ds) == 0 {
		b.Skip("没有显示器")
	}
	img, _ := Capture(ds[0].Bounds)
	h := img.Bounds().Dy() * 1280 / img.Bounds().Dx()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		Downscale(img, 1280, h)
	}
}
