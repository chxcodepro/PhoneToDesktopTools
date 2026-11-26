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

// tileFrame 截屏 goroutine 交给编码 goroutine 的一帧（已经缩放好）。
type tileFrame struct {
	img   *image.RGBA
	d     screen.Display
	scale float64
	kind  string // 截屏方式
	err   error
}

// runTiles 截屏和编码 / 发送分在两个 goroutine 里同时做：截下一帧的同时编码上一帧。
// 截屏那边只保留最新的一帧，编码这边慢（或手机没确认）时中间的帧直接丢掉——分块是和上次发出去的画面比较，丢帧不会丢内容。
func (s *Session) runTiles(ctx context.Context, cfg streamConfig) {
	interval := time.Second / time.Duration(cfg.FPS)
	defer screen.PreciseTimers()()
	frames := make(chan tileFrame, 1)
	free := make(chan *image.RGBA, 3) // 用完的缓冲区还给截屏那边复用
	go captureTiles(ctx, cfg, interval, frames, free)

	enc := &screen.TileEncoder{Quality: cfg.Quality}
	// 之前的推流可能还有没确认的帧：当作已确认，新推流从整屏开始
	s.stream.acked.Store(s.stream.seq.Load())
	var cur tileFrame // 最近一帧的尺寸、显示器等信息
	have := false
	lastCX, lastCY := -1, -1
	lastSent := time.Time{}
	failures := 0
	var stats struct {
		frames, bytes int
		since         time.Time
		kind          string
	}
	stats.since = time.Now()
	idle := time.NewTimer(interval)
	defer idle.Stop()

	for {
		if !s.waitAcked(ctx) {
			return
		}
		if ok, why := s.Info().Permissions.Allow(perm.CatScreen, perm.Read); !ok {
			s.notify("p2d/screen.stopped", map[string]string{"reason": why})
			s.stopStream()
			return
		}
		var f tileFrame
		got := false
		if !idle.Stop() {
			select {
			case <-idle.C:
			default:
			}
		}
		idle.Reset(interval)
		select {
		case <-ctx.Done():
			return
		case f = <-frames:
			got = true
		case <-idle.C: // 画面没变：只看鼠标和心跳
		}
		if got && f.err != nil {
			failures++
			if failures == 1 || failures%20 == 0 {
				s.notify("p2d/screen.error", map[string]string{"message": f.err.Error()})
			}
			continue
		}
		var tiles []screen.Tile
		full := false
		if got {
			failures = 0
			if !have || f.d.Bounds != cur.d.Bounds || f.img.Bounds() != cur.img.Bounds() {
				enc.Reset() // 换了显示器或分辨率：整屏重发
			}
			var err error
			tiles, full, err = enc.Encode(f.img)
			if have && cur.img != f.img {
				select {
				case free <- cur.img:
				default:
				}
			}
			cur, have = f, true
			stats.kind = f.kind
			if err != nil {
				s.notify("p2d/screen.error", map[string]string{"message": err.Error()})
				continue
			}
		}
		if !have {
			continue
		}

		cx, cy, cok := screen.CursorPos()
		moved := cok && (cx != lastCX || cy != lastCY)
		if len(tiles) > 0 || full || moved || time.Since(lastSent) > tilesHeartbeat {
			p := tileParams{Seq: s.stream.seq.Add(1), Full: full, Tiles: make([]tileEntry, 0, len(tiles)),
				Width: cur.img.Bounds().Dx(), Height: cur.img.Bounds().Dy(), Scale: cur.scale, X: cur.d.X, Y: cur.d.Y,
				Display: cur.d.Index, Encoding: "image/jpeg"}
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
				log.Printf("[会话 %d] 远程桌面推流：最近 1 分钟 %d 帧有变化，平均每帧 %d KB（%s）", s.id, stats.frames, stats.bytes/stats.frames/1024, stats.kind)
			}
			stats.frames, stats.bytes, stats.since = 0, 0, time.Now()
		}
	}
}

// captureTiles 截屏 goroutine：按帧率截取（桌面复制时画面不变就不出帧），缩放后交给编码 goroutine。
func captureTiles(ctx context.Context, cfg streamConfig, interval time.Duration, frames chan tileFrame, free chan *image.RGBA) {
	var src screen.Source
	defer func() {
		if src != nil {
			src.Close()
		}
	}()
	var d screen.Display
	var checked time.Time
	kind := ""
	publish := func(f tileFrame) {
		select {
		case old := <-frames: // 编码那边还没取走的旧帧直接丢掉
			if old.img != nil {
				select {
				case free <- old.img:
				default:
				}
			}
		default:
		}
		frames <- f
	}
	var last time.Time // 上一次交出画面的时间
	for ctx.Err() == nil {
		// 按帧率限速：离上一帧不到一帧的时间就等一等（画面没变时不用等，Next 自己会等变化）
		if rest := interval - time.Since(last); rest > 0 {
			sleepCtx(ctx, rest)
		}
		// 每秒检查一次显示器：换了位置 / 分辨率就重新打开截屏
		if src == nil || time.Since(checked) > time.Second {
			checked = time.Now()
			displays, err := screen.Displays()
			if err != nil {
				publish(tileFrame{err: err})
				sleepCtx(ctx, time.Second)
				continue
			}
			nd := displays[0]
			if cfg.Display < len(displays) {
				nd = displays[cfg.Display]
			}
			if src == nil || nd.Bounds != d.Bounds {
				if src != nil {
					src.Close()
				}
				d = nd
				src = screen.OpenSource(d)
			}
			d.Index = nd.Index
		}
		if k := src.Kind(); k != kind {
			kind = k
			log.Printf("远程桌面截屏方式：%s", kind)
		}
		img, err := src.Next(100 * time.Millisecond)
		if err != nil {
			publish(tileFrame{err: err})
			sleepCtx(ctx, time.Second)
			continue
		}
		if img != nil {
			var buf *image.RGBA
			select {
			case buf = <-free:
			default:
			}
			scale := 1.0
			w, h := img.Bounds().Dx(), img.Bounds().Dy()
			if cfg.MaxWidth > 0 && w > cfg.MaxWidth {
				scale = float64(cfg.MaxWidth) / float64(w)
				buf = screen.DownscaleInto(buf, img, cfg.MaxWidth, int(float64(h)*scale+0.5))
			} else {
				// 截屏的缓冲区下一帧会被改写，复制一份交出去
				if buf == nil || buf.Bounds() != img.Bounds() {
					buf = image.NewRGBA(img.Bounds())
				}
				copy(buf.Pix, img.Pix)
			}
			last = time.Now()
			publish(tileFrame{img: buf, d: d, scale: scale, kind: kind})
		}
	}
}
