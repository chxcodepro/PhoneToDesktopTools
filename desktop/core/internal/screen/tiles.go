package screen

import (
	"bytes"
	"image"
	"image/jpeg"
	"runtime"
	"sync"
	"sync/atomic"
)

// 分块增量编码（远程桌面推流用）：画面切成固定大小的块，记住上次发出去的像素，
// 每帧只把有变化的块编码成 JPEG。打字、滚动一小块区域时只发几块，整屏变化时多核并行编码。

// TileSize 块的边长（像素）。块越小变化区域越贴合，但每块都有约 600 字节的 JPEG 文件头。
const TileSize = 256

// Tile 一块编码后的画面，坐标是编码后画面上的像素坐标。
type Tile struct {
	X, Y, W, H int
	JPEG       []byte
}

// TileEncoder 分块增量编码器，不能并发调用。
type TileEncoder struct {
	Quality int
	sent    *image.RGBA // 已发出的画面（原始像素，不是 JPEG 解码后的）
}

// Reset 忘掉已发出的画面，下一帧整屏重发（切换显示器、重新开始推流时用）。
func (e *TileEncoder) Reset() { e.sent = nil }

// Encode 返回有变化的块；full 为 true 表示这是整屏（第一帧或画面尺寸变了），接收方应先清空画布。
func (e *TileEncoder) Encode(img *image.RGBA) (tiles []Tile, full bool, err error) {
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	if e.sent == nil || e.sent.Bounds().Dx() != w || e.sent.Bounds().Dy() != h {
		e.sent = image.NewRGBA(image.Rect(0, 0, w, h))
		full = true
	}
	cols := (w + TileSize - 1) / TileSize
	rows := (h + TileSize - 1) / TileSize
	n := cols * rows
	out := make([]*Tile, n)
	errs := make([]error, n)

	workers := runtime.NumCPU()
	if workers > 8 {
		workers = 8
	}
	if workers > n {
		workers = n
	}
	var next int64 = -1
	var wg sync.WaitGroup
	for k := 0; k < workers; k++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				i := int(atomic.AddInt64(&next, 1))
				if i >= n {
					return
				}
				// 不用 image.Rect：它会把 Min > Max 的参数对调
				x0, y0 := (i%cols)*TileSize, (i/cols)*TileSize
				r := image.Rectangle{Min: image.Pt(x0, y0), Max: image.Pt(x0+TileSize, y0+TileSize)}
				if r.Max.X > w {
					r.Max.X = w
				}
				if r.Max.Y > h {
					r.Max.Y = h
				}
				if !full && sameRegion(img, e.sent, r) {
					continue
				}
				var buf bytes.Buffer
				sub := img.SubImage(r.Add(b.Min))
				if err := jpeg.Encode(&buf, sub, &jpeg.Options{Quality: e.Quality}); err != nil {
					errs[i] = err
					continue
				}
				copyRegion(e.sent, img, r)
				out[i] = &Tile{X: r.Min.X, Y: r.Min.Y, W: r.Dx(), H: r.Dy(), JPEG: buf.Bytes()}
			}
		}()
	}
	wg.Wait()
	for i := range out {
		if errs[i] != nil {
			e.sent = nil // 状态已经不一致，下一帧整屏重发
			return nil, false, errs[i]
		}
		if out[i] != nil {
			tiles = append(tiles, *out[i])
		}
	}
	return tiles, full, nil
}

// sameRegion 比较 img（按自身 Bounds 偏移）与 sent 在 r 内的像素是否相同。
func sameRegion(img, sent *image.RGBA, r image.Rectangle) bool {
	ox, oy := img.Bounds().Min.X, img.Bounds().Min.Y
	n := r.Dx() * 4
	for y := r.Min.Y; y < r.Max.Y; y++ {
		a := img.Pix[img.PixOffset(r.Min.X+ox, y+oy):][:n]
		s := sent.Pix[sent.PixOffset(r.Min.X, y):][:n]
		if !bytes.Equal(a, s) {
			return false
		}
	}
	return true
}

func copyRegion(sent, img *image.RGBA, r image.Rectangle) {
	ox, oy := img.Bounds().Min.X, img.Bounds().Min.Y
	n := r.Dx() * 4
	for y := r.Min.Y; y < r.Max.Y; y++ {
		copy(sent.Pix[sent.PixOffset(r.Min.X, y):][:n], img.Pix[img.PixOffset(r.Min.X+ox, y+oy):][:n])
	}
}
