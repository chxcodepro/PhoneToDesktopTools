package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"log"
	"sync"
	"sync/atomic"
	"time"

	"p2d/core/internal/perm"
	"p2d/core/internal/screen"
)

// 远程桌面推流（自定义扩展）：
//   p2d/screen.start {display, maxWidth, quality, fps} → 开始推送 p2d/screen.frame 通知
//   p2d/screen.stop                                     → 停止
// 画面没有变化时只推送鼠标位置（不带 data），节省 USB 带宽。
// 手机端带 tiles:true 时改推分块增量画面（p2d/screen.tiles，见 tilestream.go）。

type streamConfig struct {
	Display  int `json:"display"`
	MaxWidth int `json:"maxWidth"`
	Quality  int `json:"quality"`
	FPS      int `json:"fps"`
	// Tiles 手机端能画分块画面（原生画布）。为 true 时推 p2d/screen.tiles，否则推整帧 p2d/screen.frame
	Tiles bool `json:"tiles"`
	// Video 手机端能硬件解码视频（见 videostream.go）。电脑端打开硬件编码器成功就推视频，否则退回分块
	Video *videoRequest `json:"video,omitempty"`
}

// streamStarted p2d/screen.start 的结果
type streamStarted struct {
	Displays []screen.Display `json:"displays"`
	Tiles    bool             `json:"tiles"`
	Video    *videoInfo       `json:"video,omitempty"`
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
	// 分块推流的流控：seq 是本会话发出的最后一帧编号（跨多次推流递增），acked 是手机画完确认的最大编号
	seq   atomic.Int64
	acked atomic.Int64
	ackCh chan struct{}
	// keyframe 手机要一个关键帧（视频流）
	keyframe atomic.Bool
}

func (s *Session) notify(method string, params any) {
	b, err := json.Marshal(params)
	if err != nil {
		return
	}
	s.send(rpcMessage{Method: method, Params: b})
}

func (s *Session) startStream(cfg streamConfig) (*streamStarted, error) {
	if cfg.MaxWidth <= 0 {
		cfg.MaxWidth = 1280
	}
	// 整帧推流每帧都发整屏，限制在 2560；分块推流只发变化的块，可以到 4K
	maxW := 2560
	if cfg.Tiles {
		maxW = 3840
	}
	if cfg.MaxWidth > maxW {
		cfg.MaxWidth = maxW
	}
	if cfg.Quality <= 0 || cfg.Quality > 100 {
		cfg.Quality = 60
	}
	if cfg.FPS <= 0 {
		cfg.FPS = 10
	}
	// 整帧推流每帧都要编码整屏，最多 30 帧/秒；分块推流只编码变化的块，放到 60 帧/秒
	maxFPS := 30
	if cfg.Tiles {
		maxFPS = 60
	}
	if cfg.Video != nil {
		maxFPS = 120
	}
	if cfg.FPS > maxFPS {
		cfg.FPS = maxFPS
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
	if s.stream.ackCh == nil {
		s.stream.ackCh = make(chan struct{}, 1)
	}
	s.stream.mu.Unlock()
	// 显示器闲置关了就唤醒；推流期间不让电脑息屏、睡眠（息屏后很多电脑会接着锁屏，锁屏后就截不到了）
	screen.WakeDisplay()
	release := screen.KeepAwake()
	go func() {
		<-ctx.Done()
		release()
	}()
	started := &streamStarted{Displays: displays}
	if cfg.Video != nil && cfg.Video.Codec == "h264" && screen.Locked() {
		// 锁屏时硬件编码器也打不开桌面复制：先告诉手机在电脑上解锁，解锁后再按正常流程开始（能推视频就推视频）。
		// 手机端收到视频帧时自己切到视频显示，不用重新请求
		started.Tiles = cfg.Tiles
		log.Printf("[会话 %d] 电脑已锁屏，等解锁后开始远程桌面推流", s.id)
		go s.waitUnlock(ctx, cfg)
		return started, nil
	}
	s.launchStream(ctx, cfg, started)
	return started, nil
}

// waitUnlock 电脑锁屏时先等解锁（期间每 10 秒提醒一次手机），解锁后开始推流。
func (s *Session) waitUnlock(ctx context.Context, cfg streamConfig) {
	var told time.Time
	for screen.Locked() {
		if time.Since(told) >= 10*time.Second {
			s.notify("p2d/screen.error", map[string]string{"message": screen.ErrLocked.Error()})
			told = time.Now()
		}
		sleepCtx(ctx, 500*time.Millisecond)
		if ctx.Err() != nil {
			return
		}
	}
	log.Printf("[会话 %d] 电脑已解锁", s.id)
	screen.WakeDisplay()
	s.launchStream(ctx, cfg, &streamStarted{})
}

// launchStream 按手机的能力开始推流：能推硬件视频就推视频，否则分块（或整帧）。started 记下实际用的方式。
func (s *Session) launchStream(ctx context.Context, cfg streamConfig, started *streamStarted) {
	if cfg.Video != nil && cfg.Video.Codec == "h264" {
		if info := s.startVideo(ctx, cfg); info != nil {
			started.Video = info
			// 也回 tiles：手机端只认 tiles 判断电脑端是不是旧版，没有 tiles 会退回整帧推流重新开始
			started.Tiles = cfg.Tiles
			log.Printf("[会话 %d] 开始远程桌面推流（显示器 %d，%d fps，%dx%d，硬件视频 %s）", s.id, cfg.Display, cfg.FPS, info.Width, info.Height, info.Encoder)
			return
		}
	}
	if ctx.Err() != nil {
		return
	}
	if cfg.FPS > 60 {
		cfg.FPS = 60
	}
	mode := "整帧"
	if cfg.Tiles {
		mode = "分块"
	}
	log.Printf("[会话 %d] 开始远程桌面推流（显示器 %d，%d fps，宽 %d，%s）", s.id, cfg.Display, cfg.FPS, cfg.MaxWidth, mode)
	if cfg.Tiles {
		go s.runTiles(ctx, cfg)
	} else {
		go s.runStream(ctx, cfg)
	}
	started.Tiles = cfg.Tiles
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
	defer screen.PreciseTimers()()
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
				// 画面没变且不需要补发完整画面时，跳过 JPEG 编码
				skip := lastHash
				if time.Since(lastSent) > 2*time.Second {
					skip = 0
				}
				frame, err = screen.EncodeIfChanged(img, cfg.MaxWidth, cfg.Quality, skip)
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
			if frame.JPEG != nil && (changed || time.Since(lastSent) > 2*time.Second) {
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
