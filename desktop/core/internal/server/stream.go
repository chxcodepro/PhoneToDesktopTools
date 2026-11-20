package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"log"
	"sync"
	"time"

	"p2d/core/internal/perm"
	"p2d/core/internal/screen"
)

// 远程桌面推流（自定义扩展）：
//   p2d/screen.start {display, maxWidth, quality, fps} → 开始推送 p2d/screen.frame 通知
//   p2d/screen.stop                                     → 停止
// 画面没有变化时只推送鼠标位置（不带 data），节省 USB 带宽。

type streamConfig struct {
	Display  int `json:"display"`
	MaxWidth int `json:"maxWidth"`
	Quality  int `json:"quality"`
	FPS      int `json:"fps"`
}

type frameParams struct {
	Seq      int64   `json:"seq"`
	Data     string  `json:"data,omitempty"` // JPEG base64，画面没变化时省略
	MimeType string  `json:"mimeType,omitempty"`
	Width    int     `json:"width"` // 图片尺寸
	Height   int     `json:"height"`
	Scale    float64 `json:"scale"` // 图片尺寸 / 屏幕尺寸
	X        int     `json:"x"`     // 显示器左上角的屏幕坐标
	Y        int     `json:"y"`
	CursorX  *int    `json:"cursorX,omitempty"` // 鼠标的屏幕坐标
	CursorY  *int    `json:"cursorY,omitempty"`
	Display  int     `json:"display"`
}

type streamState struct {
	mu     sync.Mutex
	cancel context.CancelFunc
}

func (s *Session) notify(method string, params any) {
	b, err := json.Marshal(params)
	if err != nil {
		return
	}
	s.send(rpcMessage{Method: method, Params: b})
}

func (s *Session) startStream(cfg streamConfig) ([]screen.Display, error) {
	if cfg.MaxWidth <= 0 {
		cfg.MaxWidth = 1280
	}
	if cfg.MaxWidth > 2560 {
		cfg.MaxWidth = 2560
	}
	if cfg.Quality <= 0 || cfg.Quality > 100 {
		cfg.Quality = 60
	}
	if cfg.FPS <= 0 {
		cfg.FPS = 10
	}
	if cfg.FPS > 20 {
		cfg.FPS = 20
	}
	displays, err := screen.Displays()
	if err != nil {
		return nil, err
	}
	if cfg.Display < 0 || cfg.Display >= len(displays) {
		cfg.Display = 0
	}
	s.stopStream()
	ctx, cancel := context.WithCancel(s.ctx)
	s.stream.mu.Lock()
	s.stream.cancel = cancel
	s.stream.mu.Unlock()
	log.Printf("[会话 %d] 开始远程桌面推流（显示器 %d，%d fps，宽 %d）", s.id, cfg.Display, cfg.FPS, cfg.MaxWidth)
	go s.runStream(ctx, cfg)
	return displays, nil
}

func (s *Session) stopStream() {
	s.stream.mu.Lock()
	if s.stream.cancel != nil {
		s.stream.cancel()
		s.stream.cancel = nil
		log.Printf("[会话 %d] 停止远程桌面推流", s.id)
	}
	s.stream.mu.Unlock()
}

func (s *Session) runStream(ctx context.Context, cfg streamConfig) {
	interval := time.Second / time.Duration(cfg.FPS)
	var seq int64
	var lastHash uint64
	lastCX, lastCY := -1, -1
	lastSent := time.Time{}
	failures := 0

	for {
		if ctx.Err() != nil {
			return
		}
		begin := time.Now()
		if ok, why := s.Info().Permissions.Allow(perm.CatScreen, perm.Read); !ok {
			s.notify("p2d/screen.stopped", map[string]string{"reason": why})
			s.stopStream()
			return
		}

		displays, err := screen.Displays()
		if err == nil && cfg.Display >= len(displays) {
			cfg.Display = 0
		}
		var frame *screen.Frame
		var d screen.Display
		if err == nil {
			d = displays[cfg.Display]
			var img, capErr = screen.Capture(d.Bounds)
			err = capErr
			if err == nil {
				frame, err = screen.Encode(img, cfg.MaxWidth, cfg.Quality)
			}
		}
		if err != nil {
			failures++
			if failures == 1 || failures%20 == 0 {
				s.notify("p2d/screen.error", map[string]string{"message": err.Error()})
			}
			sleepCtx(ctx, time.Second)
			continue
		}
		failures = 0

		cx, cy, cok := screen.CursorPos()
		changed := frame.Hash != lastHash
		moved := cok && (cx != lastCX || cy != lastCY)
		if changed || moved || time.Since(lastSent) > 2*time.Second {
			seq++
			p := frameParams{Seq: seq, Width: frame.Width, Height: frame.Height, Scale: frame.Scale,
				X: d.X, Y: d.Y, Display: d.Index}
			if changed || time.Since(lastSent) > 2*time.Second {
				p.Data = base64.StdEncoding.EncodeToString(frame.JPEG)
				p.MimeType = "image/jpeg"
				lastHash = frame.Hash
			}
			if cok {
				p.CursorX, p.CursorY = &cx, &cy
				lastCX, lastCY = cx, cy
			}
			s.notify("p2d/screen.frame", p) // WebSocket 写入阻塞时自然限速
			lastSent = time.Now()
		}
		if rest := interval - time.Since(begin); rest > 0 {
			sleepCtx(ctx, rest)
		}
	}
}

func sleepCtx(ctx context.Context, d time.Duration) {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
	case <-t.C:
	}
}
