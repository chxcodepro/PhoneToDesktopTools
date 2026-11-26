//go:build darwin && !cgo

package screen

import (
	"errors"
	"image"
)

// Mac 版截图要用 cgo 调用 CoreGraphics；没开 cgo 编译（比如在 Windows 上交叉编译检查）时都返回错误。
var errNoCgo = errors.New("这个程序编译时没有启用 cgo，Mac 上不能截图")

// Init 无需初始化。
func Init() {}

// Displays 没有 cgo 时不可用。
func Displays() ([]Display, error) { return nil, errNoCgo }

// Capture 没有 cgo 时不可用。
func Capture(r image.Rectangle) (*image.RGBA, error) { return nil, errNoCgo }

// CursorPos 没有 cgo 时不可用。
func CursorPos() (x, y int, ok bool) { return 0, 0, false }
