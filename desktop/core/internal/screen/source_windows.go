//go:build windows

package screen

import (
	"errors"
	"image"
	"syscall"
	"time"
)

// OpenSource 打开一个显示器的连续截屏：Windows 8 起用 DXGI 桌面复制，打不开（Win7、远程桌面会话等）时用 GDI。
// 桌面复制中途失败（锁屏、UAC 安全桌面、切换分辨率）时先用 GDI 顶上，过几秒再试着打开。
func OpenSource(d Display) Source {
	s := &winSource{bounds: d.Bounds, retry: 2 * time.Second}
	s.open()
	return s
}

type winSource struct {
	bounds  image.Rectangle
	dx      *dxgiCapturer
	why     string // 没用桌面复制的原因
	never   bool   // 系统不支持，不再尝试
	retryAt time.Time
	retry   time.Duration
	lostAt  time.Time
}

func (s *winSource) open() {
	c, err := openDXGI(s.bounds)
	if err != nil {
		s.why = err.Error()
		s.never = errors.Is(err, errNoDuplication)
		s.retryAt = time.Now().Add(s.retry)
		if s.retry < 30*time.Second {
			s.retry *= 2
		}
		return
	}
	s.dx, s.why, s.retry = c, "", 2*time.Second
}

func (s *winSource) Next(wait time.Duration) (*image.RGBA, error) {
	if s.dx == nil && !s.never && time.Now().After(s.retryAt) {
		s.open()
	}
	if s.dx != nil {
		img, err := s.dx.next(wait)
		switch {
		case err == nil:
			s.lostAt = time.Time{}
			return img, nil
		case errors.Is(err, errDuplicationUnchanged):
			if !s.dx.hasImage() {
				return Capture(s.bounds) // 画面一直没变，桌面复制还没给过画面：先用 GDI 截一张
			}
			return nil, nil
		case errors.Is(err, errDuplicationLost):
			// 切换桌面时会短暂中断，下一次调用会重新复制；连续中断超过 1 秒就先用 GDI
			if s.lostAt.IsZero() {
				s.lostAt = time.Now()
			}
			if time.Since(s.lostAt) < time.Second {
				time.Sleep(50 * time.Millisecond)
				return nil, nil
			}
			s.why = err.Error()
		default:
			s.why = err.Error()
		}
		s.dx.Close()
		s.dx = nil
		s.lostAt = time.Time{}
		s.retryAt = time.Now().Add(s.retry)
	}
	return Capture(s.bounds)
}

func (s *winSource) Kind() string {
	if s.dx != nil {
		return "DXGI 桌面复制"
	}
	if s.why == "" {
		return "GDI"
	}
	return "GDI（" + s.why + "）"
}

func (s *winSource) Close() {
	if s.dx != nil {
		s.dx.Close()
		s.dx = nil
	}
}

var (
	winmm               = syscall.NewLazyDLL("winmm.dll")
	procTimeBeginPeriod = winmm.NewProc("timeBeginPeriod")
	procTimeEndPeriod   = winmm.NewProc("timeEndPeriod")
)

// PreciseTimers 推流期间把系统计时器精度调到 1 毫秒，返回恢复函数。
// Go 1.20 在 Windows 上的定时器精度跟着系统走，默认 15.6 毫秒：等 33 毫秒实际要 46 毫秒，30 帧/秒只能到 21 帧/秒。
func PreciseTimers() func() {
	if procTimeBeginPeriod.Find() != nil {
		return func() {}
	}
	procTimeBeginPeriod.Call(1)
	return func() { procTimeEndPeriod.Call(1) }
}
