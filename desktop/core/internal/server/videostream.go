package server

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"log"
	"os"
	"strconv"
	"time"

	"p2d/core/internal/perm"
	"p2d/core/internal/screen"
)

// 硬件视频流（Windows 8 起、电脑有显卡硬件编码器、手机能硬件解码时）：
//   - 手机端 p2d/screen.start 带 video:{codec:"h264", maxWidth, maxHeight, maxFps}（解码器支持的上限）；
//   - 电脑端打开硬件编码器成功就回复 video:{codec, width, height, encoder}，之后推二进制消息；失败就退回分块推流；
//   - 二进制消息：4 字节 "P2DV" + 4 字节小端 JSON 长度 + JSON（seq、key、width、height、scale、x、y、display、cursorX、cursorY）+ H.264 数据（Annex B）；
//   - 手机解码显示完回 p2d/screen.ack {seq}，最多 videoInFlight 帧没确认。手机慢时电脑端少编几帧
//     （不丢已经编好的帧：丢一帧后面的就都解不出来）；
//   - 手机要关键帧时发 p2d/screen.keyframe；画面不变时鼠标位置单独用 p2d/screen.cursor 通知。

const (
	videoMagic    = "P2DV"
	videoInFlight = 3
	videoRefine   = 2 // 画面停下来后把最后一帧再编几次，把运动时降下去的画质补回来
	videoMinRate  = 1_500_000
)

type videoRequest struct {
	Codec     string `json:"codec"`
	MaxWidth  int    `json:"maxWidth"`
	MaxHeight int    `json:"maxHeight"`
	MaxFPS    int    `json:"maxFps"`
}

type videoInfo struct {
	Codec   string `json:"codec"`
	Width   int    `json:"width"`
	Height  int    `json:"height"`
	Encoder string `json:"encoder"`
	Bitrate int    `json:"bitrate"`
}

type videoMeta struct {
	Seq     int64   `json:"seq"`
	Key     bool    `json:"key,omitempty"`
	Width   int     `json:"width"`
	Height  int     `json:"height"`
	Scale   float64 `json:"scale"`
	X       int     `json:"x"`
	Y       int     `json:"y"`
	Display int     `json:"display"`
	CursorX *int    `json:"cursorX,omitempty"`
	CursorY *int    `json:"cursorY,omitempty"`
}

// startVideo 在推流 goroutine 里打开硬件编码器，等它的结果（最多 5 秒）。失败返回 nil。
func (s *Session) startVideo(ctx context.Context, cfg streamConfig) *videoInfo {
	vctx, cancel := context.WithCancel(ctx)
	ready := make(chan *videoInfo, 1)
	go s.runVideo(vctx, cfg, ready)
	select {
	case info := <-ready:
		if info == nil {
			cancel()
			return nil
		}
		go func() { // 推流停止（父 context 取消）时一起释放
			<-ctx.Done()
			cancel()
		}()
		return info
	case <-time.After(5 * time.Second):
		cancel()
		log.Printf("[会话 %d] 打开硬件编码器超时，改用分块推流", s.id)
		return nil
	}
}

// videoSize 视频输出尺寸：不超过手机要的宽度和解码器支持的宽高。
func videoSize(d screen.Display, maxWidth int, req *videoRequest) (int, int) {
	if req.MaxWidth > 0 && (maxWidth <= 0 || req.MaxWidth < maxWidth) {
		maxWidth = req.MaxWidth
	}
	w, h := screen.VideoSize(d.Width, d.Height, maxWidth)
	if req.MaxHeight > 0 && h > req.MaxHeight {
		w, h = screen.VideoSize(d.Width, d.Height, d.Width*req.MaxHeight/d.Height)
	}
	return w, h
}

func (s *Session) runVideo(ctx context.Context, cfg streamConfig, ready chan<- *videoInfo) {
	defer screen.PreciseTimers()()
	defer screen.VideoThread()()
	displays, err := screen.Displays()
	if err != nil || len(displays) == 0 {
		ready <- nil
		return
	}
	d := displays[0]
	if cfg.Display < len(displays) {
		d = displays[cfg.Display]
	}
	w, h := videoSize(d, cfg.MaxWidth, cfg.Video)
	fps := cfg.FPS
	if cfg.Video.MaxFPS > 0 && fps > cfg.Video.MaxFPS {
		fps = cfg.Video.MaxFPS
	}
	// 调试用：P2D_VIDEO_FPS 强制视频帧率（不看手机要的和解码器上限），用来试高帧率
	if n, _ := strconv.Atoi(os.Getenv("P2D_VIDEO_FPS")); n > 0 && n <= 240 {
		fps = n
		log.Printf("[会话 %d] 视频帧率按 P2D_VIDEO_FPS 设为 %d", s.id, fps)
	}
	v, err := screen.OpenVideo(d, screen.VideoConfig{Width: w, Height: h, FPS: fps})
	if err != nil {
		log.Printf("[会话 %d] 不能用硬件视频流，改用分块推流：%v", s.id, err)
		ready <- nil
		return
	}
	defer v.Close()
	ready <- &videoInfo{Codec: "h264", Width: w, Height: h, Encoder: v.Name(), Bitrate: screen.DefaultBitrate(w, h, fps)}
	if ctx.Err() != nil {
		return
	}
	s.stream.acked.Store(s.stream.seq.Load())
	s.stream.keyframe.Store(false)
	scale := float64(w) / float64(d.Width)
	interval := time.Second / time.Duration(fps)

	// 码率自适应：每秒看一次有多少个帧位（按帧率算）想编新画面却因为手机没确认而等着（网络或手机跟不上），
	// 超过一半就降 20%，基本不等就慢慢升回默认码率。按帧位算而不是按循环次数算：
	// 循环每毫秒转一次，按次数算的话一秒里只等十几毫秒就会被当成跟不上，码率很快掉到最低
	baseRate := screen.DefaultBitrate(w, h, fps)
	rate, blocked, lastAdjust := baseRate, 0, time.Now()
	var lastFeed, lastChange, lastCursor, lastPerm, lastAck, lastBlocked, lockTold time.Time
	lastAcked := s.stream.acked.Load()
	refined := videoRefine
	lastCX, lastCY := -1, -1
	var stats struct {
		frames, bytes, blocked int
		since                  time.Time
	}
	stats.since = time.Now()

	for ctx.Err() == nil {
		now := time.Now()
		if now.Sub(lastPerm) > 500*time.Millisecond {
			lastPerm = now
			if ok, why := s.Info().Permissions.Allow(perm.CatScreen, perm.Read); !ok {
				s.notify("p2d/screen.stopped", map[string]string{"reason": why})
				s.stopStream()
				return
			}
		}
		if s.stream.keyframe.Swap(false) {
			v.RequestKeyFrame()
		}
		f, err := v.Poll()
		if err != nil {
			log.Printf("[会话 %d] 硬件编码出错，停止推流：%v", s.id, err)
			s.notify("p2d/screen.stopped", map[string]string{"reason": "硬件编码出错：" + err.Error()})
			s.stopStream()
			return
		}
		if f != nil {
			cx, cy, cok := screen.CursorPos()
			m := videoMeta{Seq: s.stream.seq.Add(1), Key: f.Key, Width: w, Height: h, Scale: scale, X: d.X, Y: d.Y, Display: d.Index}
			if cok {
				m.CursorX, m.CursorY = &cx, &cy
				lastCX, lastCY = cx, cy
			}
			s.sendBinary(videoMessage(m, f.Data))
			lastCursor = time.Now()
			stats.frames++
			stats.bytes += len(f.Data)
			continue
		}

		// 流控：手机确认得慢就先不编新的；确认超过 2 秒没动静当作已确认（防止确认丢了卡住）
		if a := s.stream.acked.Load(); a != lastAcked || lastAck.IsZero() {
			lastAcked, lastAck = a, now
		}
		inflight := s.stream.seq.Load() - lastAcked
		if inflight >= videoInFlight && now.Sub(lastAck) > tilesAckWait {
			s.stream.acked.Store(s.stream.seq.Load())
			lastAcked, lastAck = s.stream.seq.Load(), now
			inflight = 0
		}
		if now.Sub(lastAdjust) >= time.Second {
			nr := rate
			if blocked > fps/2 {
				nr = rate * 4 / 5
				if nr < videoMinRate {
					nr = videoMinRate
				}
			} else if blocked <= fps/10 && rate < baseRate {
				nr = rate * 11 / 10
				if nr > baseRate {
					nr = baseRate
				}
			}
			if nr != rate {
				rate = nr
				v.SetBitrate(rate)
			}
			blocked, lastAdjust = 0, now
		}
		if v.CanFeed() && inflight >= videoInFlight && now.Sub(lastFeed) >= interval && now.Sub(lastBlocked) >= interval {
			blocked++
			stats.blocked++
			lastBlocked = now
		}
		if v.CanFeed() && inflight < videoInFlight && now.Sub(lastFeed) >= interval {
			fed, err := v.Feed(8 * time.Millisecond)
			switch {
			case errors.Is(err, screen.ErrCaptureLost):
				// 推流中锁屏了：装了锁屏助手就改推锁屏画面，解锁后再推视频；
				// 否则告诉手机在电脑上解锁（每 10 秒一次），解锁后桌面复制自己恢复
				if cfg.Tiles && screen.Locked() && screen.CanSeeLocked() {
					log.Printf("[会话 %d] 电脑锁屏了，改推锁屏画面，解锁后再推视频", s.id)
					go s.runLocked(ctx, cfg)
					return
				}
				if screen.Locked() && time.Since(lockTold) >= 10*time.Second {
					s.notify("p2d/screen.error", map[string]string{"message": screen.ErrLocked.Error()})
					lockTold = time.Now()
				}
				sleepCtx(ctx, 200*time.Millisecond)
			case err != nil:
				log.Printf("[会话 %d] 截屏出错：%v", s.id, err)
				sleepCtx(ctx, 500*time.Millisecond)
			case fed:
				lastFeed, lastChange, refined = time.Now(), time.Now(), 0
			case refined < videoRefine && time.Since(lastChange) > 300*time.Millisecond:
				if ok, _ := v.Refeed(); ok {
					refined++
					lastFeed, lastChange = time.Now(), time.Now()
				}
			}
			continue
		}

		// 画面没变时单独更新鼠标位置（也当心跳）
		if now.Sub(lastCursor) >= interval {
			cx, cy, cok := screen.CursorPos()
			if cok && (cx != lastCX || cy != lastCY || now.Sub(lastCursor) > tilesHeartbeat) {
				s.notify("p2d/screen.cursor", map[string]int{"x": cx, "y": cy})
				lastCX, lastCY, lastCursor = cx, cy, now
			}
		}
		if time.Since(stats.since) >= time.Minute {
			if stats.frames > 0 {
				log.Printf("[会话 %d] 远程桌面推流：最近 1 分钟 %d 帧，平均每帧 %d KB，%.1f Mbps，码率上限 %.1f Mbps，等手机确认 %d 帧位（硬件视频 %s）",
					s.id, stats.frames, stats.bytes/stats.frames/1024, float64(stats.bytes*8)/60/1e6, float64(rate)/1e6, stats.blocked, v.Name())
			}
			stats.frames, stats.bytes, stats.blocked, stats.since = 0, 0, 0, time.Now()
		}
		sleepCtx(ctx, time.Millisecond)
	}
}

// videoMessage 拼一条视频二进制消息。
func videoMessage(m videoMeta, data []byte) []byte {
	meta, _ := json.Marshal(m)
	b := make([]byte, 8+len(meta)+len(data))
	copy(b, videoMagic)
	binary.LittleEndian.PutUint32(b[4:], uint32(len(meta)))
	copy(b[8:], meta)
	copy(b[8+len(meta):], data)
	return b
}
