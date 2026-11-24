package tools

import (
	"image"
	"image/color"
	"testing"
)

func TestZoomHelpers(t *testing.T) {
	src := image.NewRGBA(image.Rect(0, 0, 2, 1))
	src.Set(0, 0, color.RGBA{255, 0, 0, 255})
	src.Set(1, 0, color.RGBA{0, 0, 255, 255})
	d := upscale(src, 3)
	if d.Bounds().Dx() != 6 || d.Bounds().Dy() != 3 {
		t.Fatal(d.Bounds())
	}
	if d.RGBAAt(2, 2).R != 255 || d.RGBAAt(3, 0).B != 255 || d.RGBAAt(5, 2).B != 255 {
		t.Fatal("像素复制不对")
	}
	for _, c := range []struct{ w, h, maxW, want int }{{400, 240, 1280, 3}, {600, 400, 1280, 2}, {1000, 600, 1280, 1}, {300, 1000, 1280, 1}} {
		if got := zoomFactor(c.w, c.h, c.maxW); got != c.want {
			t.Errorf("zoomFactor(%d,%d) = %d，应为 %d", c.w, c.h, got, c.want)
		}
	}
	if w := defaultShotWidth(2560, 1600); w != 1264 {
		t.Errorf("16:10 默认宽 %d", w)
	}
	if w := defaultShotWidth(2560, 1440); w != 1280 {
		t.Errorf("16:9 默认宽 %d", w)
	}
}

func TestFromRelative(t *testing.T) {
	rememberShot(shotMap{scale: 0.5, x: 0, y: -1440, w: 1280, h: 720})
	x, y, err := fromRelative(500, 500)
	if err != nil || x != 1280 || y != -720 {
		t.Fatalf("(%d,%d) %v", x, y, err)
	}
	if _, _, err := fromRelative(1200, 10); err == nil {
		t.Fatal("超出 1000 应报错")
	}
	r, err := regionFromShot([]int{600, 300, 200, 120})
	if err != nil || r != image.Rect(1200, -840, 1600, -600) {
		t.Fatalf("%v %v", r, err)
	}
	if _, err := regionFromShot([]int{1, 2}); err == nil {
		t.Fatal("参数不对应报错")
	}
}
