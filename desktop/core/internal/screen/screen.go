// Package screen 截取屏幕。Windows 使用 GDI（兼容 Win7），Linux 使用 X11（纯 Go，无 cgo），Mac 使用 CoreGraphics（cgo）。
package screen

import "image"

// Display 描述一个显示器在虚拟桌面中的位置（像素）。
type Display struct {
	Index   int             `json:"index"`
	Bounds  image.Rectangle `json:"-"`
	X       int             `json:"x"`
	Y       int             `json:"y"`
	Width   int             `json:"width"`
	Height  int             `json:"height"`
	Primary bool            `json:"primary"`
	// Scale 系统缩放比例（1.75 = 175%）；取不到时为 1
	Scale float64 `json:"scale"`
}

func newDisplay(i int, r image.Rectangle, primary bool) Display {
	return Display{Index: i, Bounds: r, X: r.Min.X, Y: r.Min.Y, Width: r.Dx(), Height: r.Dy(), Primary: primary, Scale: 1}
}

// foregroundRect 前台窗口的位置（Windows 实现；其他系统为 nil）
var foregroundRect func() (image.Rectangle, bool)

// ActiveDisplay 前台窗口所在的显示器序号（窗口跨屏时取占得多的那个）；取不到时返回主显示器 0。
// 用远程软件的虚拟屏操作时，程序窗口常常不在主显示器上，截图默认截前台窗口那块屏，Agent 才看得到正在操作的窗口。
func ActiveDisplay(ds []Display) int {
	if foregroundRect == nil {
		return 0
	}
	r, ok := foregroundRect()
	if !ok || r.Empty() {
		return 0
	}
	best, area := 0, 0
	for i, d := range ds {
		in := r.Intersect(d.Bounds)
		if a := in.Dx() * in.Dy(); a > area {
			best, area = i, a
		}
	}
	return best
}
