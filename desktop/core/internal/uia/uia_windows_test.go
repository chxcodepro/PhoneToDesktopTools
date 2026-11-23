//go:build windows

package uia

import (
	"context"
	"os"
	"strings"
	"testing"
)

// 实机读取任务栏（任务栏一定存在）。设置 P2D_UIA_VERBOSE=1 时打印结果。
func TestTaskbarTree(t *testing.T) {
	if testing.Short() {
		t.Skip("需要 Windows 桌面")
	}
	out, err := Run(context.Background(), Params{Mode: "tree", Window: "任务栏", Max: 60})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "窗口：") || !strings.Contains(out, "(") {
		t.Fatalf("任务栏应能读到带坐标的元素：\n%s", out)
	}
	t.Log("\n" + out)
}

func TestFindMissingWindow(t *testing.T) {
	if testing.Short() {
		t.Skip("需要 Windows 桌面")
	}
	_, err := Run(context.Background(), Params{Mode: "tree", Window: "一个不存在的窗口标题-p2d"})
	if err == nil || !strings.Contains(err.Error(), "找不到") {
		t.Fatalf("应报找不到窗口，实际：%v", err)
	}
}

// 手动试读某个窗口：P2D_UIA_WIN=标题 go test ./internal/uia -run TestManual -v
func TestManual(t *testing.T) {
	win := os.Getenv("P2D_UIA_WIN")
	if win == "" {
		t.Skip("未设置 P2D_UIA_WIN")
	}
	mode := os.Getenv("P2D_UIA_MODE")
	if mode == "" {
		mode = "tree"
	}
	out, err := Run(context.Background(), Params{Mode: mode, Window: win, Name: os.Getenv("P2D_UIA_NAME"), Type: os.Getenv("P2D_UIA_TYPE"), Max: 40})
	t.Logf("err=%v\n%s", err, out)
}
