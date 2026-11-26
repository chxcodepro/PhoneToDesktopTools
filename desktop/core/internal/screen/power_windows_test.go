//go:build windows

package screen

import (
	"os"
	"testing"
)

// 手动检查锁屏检测：P2D_EXPECT_LOCKED=1（电脑锁着屏时）或 0（解锁时）
func TestLockedManual(t *testing.T) {
	want := os.Getenv("P2D_EXPECT_LOCKED")
	if want == "" {
		t.Skip("设置 P2D_EXPECT_LOCKED=1 / 0 手动检查")
	}
	got := Locked()
	t.Logf("Locked() = %v", got)
	if got != (want == "1") {
		t.Fatalf("锁屏检测不对：期望 %s，实际 %v", want, got)
	}
	if ds, err := Displays(); err == nil && len(ds) > 0 {
		_, err := Capture(ds[0].Bounds)
		t.Logf("GDI 截屏：%v", err)
		if got && err != ErrLocked {
			t.Fatalf("锁屏时应返回 ErrLocked，实际 %v", err)
		}
	}
	release := KeepAwake()
	release()
}
