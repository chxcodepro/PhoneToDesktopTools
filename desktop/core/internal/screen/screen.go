// Package screen 截取屏幕。Windows 使用 GDI（兼容 Win7），Linux 使用 X11（纯 Go，无 cgo）。
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
}

func newDisplay(i int, r image.Rectangle, primary bool) Display {
	return Display{Index: i, Bounds: r, X: r.Min.X, Y: r.Min.Y, Width: r.Dx(), Height: r.Dy(), Primary: primary}
}
