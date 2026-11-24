package tools

import "testing"

func TestFromShot(t *testing.T) {
	shotMu.Lock()
	lastShot = nil
	shotMu.Unlock()
	if _, _, err := fromShot(10, 10); err == nil {
		t.Fatal("没有截图时应报错")
	}
	// 2560x1600 的屏幕缩到 1280x800（scale 0.5），第二块显示器在 (2560, 0)
	rememberShot(shotMap{scale: 0.5, x: 2560, y: 0, w: 1280, h: 800})
	x, y, err := fromShot(640, 401)
	if err != nil || x != 3840 || y != 802 {
		t.Fatalf("fromShot(640, 401) = (%d, %d, %v)，应为 (3840, 802)", x, y, err)
	}
	if _, _, err := fromShot(1500, 10); err == nil {
		t.Fatal("超出截图范围应报错")
	}
}
