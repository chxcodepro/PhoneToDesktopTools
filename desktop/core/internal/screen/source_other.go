//go:build !windows

package screen

import (
	"errors"
	"time"
)

// OpenSource 打开一个显示器的连续截屏。
func OpenSource(d Display) Source { return &captureSource{bounds: d.Bounds} }

// PreciseTimers 只有 Windows 需要调计时器精度。
func PreciseTimers() func() { return func() {} }

// VideoStream 硬件视频流只有 Windows 有，其他系统推流用 JPEG 分块。
type VideoStream struct{}

func VideoThread() func() { return func() {} }

func OpenVideo(Display, VideoConfig) (*VideoStream, error) {
	return nil, errors.New("这个系统还不支持硬件视频流")
}

func DefaultBitrate(w, h, fps int) int { return 0 }

func (*VideoStream) Name() string                     { return "" }
func (*VideoStream) Size() (int, int)                 { return 0, 0 }
func (*VideoStream) RequestKeyFrame()                 {}
func (*VideoStream) SetBitrate(int)                   {}
func (*VideoStream) Poll() (*VideoFrame, error)       { return nil, nil }
func (*VideoStream) CanFeed() bool                    { return false }
func (*VideoStream) Feed(time.Duration) (bool, error) { return false, nil }
func (*VideoStream) Refeed() (bool, error)            { return false, nil }
func (*VideoStream) Close()                           {}
