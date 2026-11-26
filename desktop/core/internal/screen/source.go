package screen

import (
	"image"
	"time"
)

// Source 连续截取一个显示器的画面（远程桌面推流用），只能在一个 goroutine 里用。
type Source interface {
	// Next 取下一帧，最多等 wait。画面没变时返回 nil, nil（只有能知道画面变没变的截屏方式才会这样）。
	// 返回的图片在下一次调用 Next 前有效，调用方不能修改它。
	Next(wait time.Duration) (*image.RGBA, error)
	// Kind 现在用的截屏方式（写日志用）
	Kind() string
	Close()
}

// captureSource 每次都完整截一次屏（GDI、X11、CoreGraphics）。
type captureSource struct{ bounds image.Rectangle }

func (s *captureSource) Next(time.Duration) (*image.RGBA, error) { return Capture(s.bounds) }

func (s *captureSource) Kind() string { return "整屏截取" }

func (s *captureSource) Close() {}
