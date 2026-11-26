//go:build windows

package screen

import (
	"image"
	"image/png"
	"os"
	"testing"
	"time"
)

// TestVideoStream 用显卡硬件编码器编 3 秒 H.264：第一帧是带 SPS/PPS 的关键帧，之后能持续出帧（没有硬件编码器时跳过）。
// 设置 P2D_H264_OUT=文件名 时把码流写出来，可以用播放器打开检查。
func TestVideoStream(t *testing.T) {
	Init()
	ds, err := Displays()
	if err != nil || len(ds) == 0 {
		t.Skip("没有显示器")
	}
	defer VideoThread()()
	w, h := VideoSize(ds[0].Width, ds[0].Height, 1920)
	v, err := OpenVideo(ds[0], VideoConfig{Width: w, Height: h, FPS: 60})
	if err != nil {
		t.Skip("不能用硬件编码：", err)
	}
	defer v.Close()
	t.Logf("编码器：%s，%dx%d", v.Name(), w, h)
	var out []byte
	dec, decErr := newH264Decoder()
	if decErr != nil {
		t.Log("不能用软件解码器检查：", decErr)
	}
	var decoded *image.RGBA
	decodedN := 0
	frames, keys, bytes := 0, 0, 0
	var firstAt time.Duration
	start := time.Now()
	fedAt := map[int]time.Time{}
	fed, lat := 0, time.Duration(0)
	for time.Since(start) < 3*time.Second {
		f, err := v.Poll()
		if err != nil {
			t.Fatal(err)
		}
		if f != nil {
			if frames == 0 {
				firstAt = time.Since(start)
				if !f.Key || !hasNAL(f.Data, 7) || !hasNAL(f.Data, 8) {
					t.Fatalf("第一帧不是带 SPS/PPS 的关键帧（%d 字节）", len(f.Data))
				}
			}
			if at, ok := fedAt[frames]; ok {
				lat += time.Since(at)
			}
			frames++
			bytes += len(f.Data)
			if f.Key {
				keys++
			}
			out = append(out, f.Data...)
			if dec != nil {
				img, err := dec.decode(f.Data)
				if err != nil {
					t.Fatal("解码失败：", err)
				}
				if img != nil {
					decoded = img
					decodedN++
				}
			}
			continue
		}
		if v.CanFeed() {
			ok, err := v.Feed(5 * time.Millisecond)
			if err != nil {
				t.Fatal(err)
			}
			if ok {
				fedAt[fed] = time.Now()
				fed++
			}
			continue
		}
		time.Sleep(time.Millisecond)
	}
	if frames == 0 {
		t.Fatal("3 秒没有编出一帧")
	}
	t.Logf("第一帧 %v 出来；3 秒 %d 帧（%d 个关键帧），平均 %d KB/帧，%.1f Mbps，送进到编出平均 %v",
		firstAt, frames, keys, bytes/frames/1024, float64(bytes*8)/3/1e6, lat/time.Duration(frames))
	if p := os.Getenv("P2D_H264_OUT"); p != "" {
		_ = os.WriteFile(p, out, 0o644)
	}
	if dec != nil {
		if decoded == nil {
			t.Fatal("软件解码器一帧也没解出来")
		}
		// 和现在的屏幕比：缩到同样大小后，亮度差的平均值应该很小（画面在动，不要求完全一样）
		gdi, _ := Capture(ds[0].Bounds)
		ref := Downscale(gdi, decoded.Rect.Dx(), decoded.Rect.Dy())
		var diff, n float64
		for i := 0; i < len(ref.Pix); i += 4 * 61 {
			for c := 0; c < 3; c++ {
				d := float64(ref.Pix[i+c]) - float64(decoded.Pix[i+c])
				if d < 0 {
					d = -d
				}
				diff += d
				n++
			}
		}
		t.Logf("软件解码器解出 %d 帧（%dx%d），和屏幕平均每通道差 %.1f", decodedN, decoded.Rect.Dx(), decoded.Rect.Dy(), diff/n)
		if p := os.Getenv("P2D_H264_PNG"); p != "" {
			if fh, err := os.Create(p); err == nil {
				_ = png.Encode(fh, decoded)
				fh.Close()
			}
		}
		if diff/n > 40 {
			t.Fatalf("解出来的画面和屏幕差太多（%.1f），颜色或缩放可能不对", diff/n)
		}
	}
}
