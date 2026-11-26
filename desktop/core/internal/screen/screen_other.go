//go:build !windows && !linux && !darwin

package screen

import (
	"errors"
	"image"
)

// Init 其他平台不支持。
func Init() {}

// Displays 其他平台不支持。
func Displays() ([]Display, error) { return nil, errors.New("当前系统不支持截图") }

// Capture 其他平台不支持。
func Capture(r image.Rectangle) (*image.RGBA, error) {
	return nil, errors.New("当前系统不支持截图")
}

// CursorPos 其他平台不支持。
func CursorPos() (x, y int, ok bool) { return 0, 0, false }
