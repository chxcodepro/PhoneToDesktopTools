package server

import (
	"context"
	"encoding/base64"
	"image"
	"log"
	"time"

	"p2d/core/internal/perm"
	"p2d/core/internal/screen"
)

// 分块增量推流（p2d/screen.start 带 tiles:true）：
//   - 画面切成 256×256 的块，每帧只发有变化的块（JPEG base64）；第一帧、切换显示器、尺寸变化时整屏发，带 full:true；
//   - 手机端用原生画布把块画到对应位置，画完回 p2d/screen.ack {seq}；
//   - 流控：最多 2 帧没确认，手机画得慢时电脑端少截几帧，不会越积越多、延迟越来越大；
//   - 画面和鼠标都没变时不发，每 2 秒发一次空帧（带鼠标位置），手机端据此知道连接还在。

const (
	tilesInFlight  = 2               // 最多几帧没确认
	tilesAckWait   = 2 * time.Second // 等确认的上限，超时就当手机已经画完（防止确认丢了卡住推流）
	tilesHeartbeat = 2 * time.Second
)

type tileParams struct {
	Seq      int64       `json:"seq"`
	Full     bool        `json:"full,omitempty"`
	Tiles    []tileEntry `json:"tiles"`
	Width    int         `json:"width"` // 编码后画面尺寸
	Height   int         `json:"height"`
	Scale    float64     `json:"scale"` // 编码后尺寸 / 屏幕尺寸
	X        int         `json:"x"`     // 显示器左上角的屏幕坐标
	Y        int         `json:"y"`
	CursorX  *int        `json:"cursorX,omitempty"`
	CursorY  *int        `json:"cursorY,omitempty"`
	Display  int         `json:"display"`
	Bytes    int         `json:"bytes"` // 这一帧 JPEG 总字节数（调试用）
	Encoding string      `json:"encoding"`
}

type tileEntry struct {
	X    int    `json:"x"`
	Y    int    `json:"y"`
	W    int    `json:"w"`
	H    int    `json:"h"`
	Data string `json:"data"`
}

// ackFrame 记录手机端确认画完的帧。
func (s *Session) ackFrame(seq int64) {
	for {
		cur := s.stream.acked.Load()
		if seq <= cur || s.stream.acked.CompareAndSwap(cur, seq) {
			break
		}
	}
	s.stream.mu.Lock()
	ch := s.stream.ackCh
	s.stream.mu.Unlock()
	if ch != nil {
		select {
		case ch <- struct{}{}:
		default:
		}
	}
}

// waitAcked 等到没确认的帧少于 tilesInFlight。超时也返回，返回 false 表示推流已停止。
func (s *Session) waitAcked(ctx context.Context) bool {
	s.stream.mu.Lock()
	ch := s.stream.ackCh
	s.stream.mu.Unlock()
	deadline := time.NewTimer(tilesAckWait)
	defer deadline.Stop()
	for s.stream.seq.Load()-s.stream.acked.Load() >= tilesInFlight {
		select {
		case <-ctx.Done():
			return false
		case <-ch:
		case <-deadline.C:
			return ctx.Err() == nil
		}
	}
	return ctx.Err() == nil
}

func (s *Session) runTiles(ctx context.Context, cfg streamConfig) {
	interval := time.Second / time.Duration(cfg.FPS)
	enc := &screen.TileEncoder{Quality: cfg.Quality}
	// 之前的推流可能还有没确认的帧：当作已确认，新推流从整屏开始
	s.stream.acked.Store(s.stream.seq.Load())
	var lastBounds image.Rectangle
	lastCX, lastCY := -1, -1
	lastSent := time.Time{}
	failures := 0
	var stats struct {
		frames, bytes int
		since         time.Time
	}
	stats.since = time.Now()

	for {
		if !s.waitAcked(ctx) {
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
		var d screen.Display
		var img *image.RGBA
		if err == nil {
			d = displays[cfg.Display]
			img, err = screen.Capture(d.Bounds)
		}
		var tiles []screen.Tile
		full := false
		scale := 1.0
		if err == nil {
			if d.Bounds != lastBounds {
				enc.Reset() // 换了显示器或分辨率：整屏重发
				lastBounds = d.Bounds
			}
			if cfg.MaxWidth > 0 && img.Bounds().Dx() > cfg.MaxWidth {
				scale = float64(cfg.MaxWidth) / float64(img.Bounds().Dx())
				img = screen.Downscale(img, cfg.MaxWidth, int(float64(img.Bounds().Dy())*scale+0.5))
			}
			tiles, full, err = enc.Encode(img)
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
		moved := cok && (cx != lastCX || cy != lastCY)
		if len(tiles) > 0 || full || moved || time.Since(lastSent) > tilesHeartbeat {
			p := tileParams{Seq: s.stream.seq.Add(1), Full: full, Tiles: make([]tileEntry, 0, len(tiles)),
				Width: img.Bounds().Dx(), Height: img.Bounds().Dy(), Scale: scale, X: d.X, Y: d.Y,
				Display: d.Index, Encoding: "image/jpeg"}
			for _, t := range tiles {
				p.Tiles = append(p.Tiles, tileEntry{X: t.X, Y: t.Y, W: t.W, H: t.H, Data: base64.StdEncoding.EncodeToString(t.JPEG)})
				p.Bytes += len(t.JPEG)
			}
			if cok {
				p.CursorX, p.CursorY = &cx, &cy
				lastCX, lastCY = cx, cy
			}
			s.notify("p2d/screen.tiles", p)
			lastSent = time.Now()
			if len(tiles) > 0 {
				stats.frames++
				stats.bytes += p.Bytes
			}
		}
		if time.Since(stats.since) >= time.Minute {
			if stats.frames > 0 {
				log.Printf("[会话 %d] 远程桌面推流：最近 1 分钟 %d 帧有变化，平均每帧 %d KB", s.id, stats.frames, stats.bytes/stats.frames/1024)
			}
			stats.frames, stats.bytes, stats.since = 0, 0, time.Now()
		}
		if rest := interval - time.Since(begin); rest > 0 {
			sleepCtx(ctx, rest)
		}
	}
}
