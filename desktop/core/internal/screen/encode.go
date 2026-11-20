package screen

import (
	"bytes"
	"hash/fnv"
	"image"
	"image/jpeg"
)

// Frame 一帧编码后的画面。
type Frame struct {
	JPEG   []byte
	Width  int // 编码后图片尺寸
	Height int
	Scale  float64 // 编码后尺寸 / 原始尺寸
	Hash   uint64  // 缩放后像素的哈希，用于跳过没有变化的画面
}

// Encode 按最大宽度缩小并编码为 JPEG。
func Encode(img *image.RGBA, maxWidth, quality int) (*Frame, error) {
	out := img
	scale := 1.0
	if maxWidth > 0 && img.Bounds().Dx() > maxWidth {
		scale = float64(maxWidth) / float64(img.Bounds().Dx())
		out = Downscale(img, maxWidth, int(float64(img.Bounds().Dy())*scale+0.5))
	}
	h := fnv.New64a()
	_, _ = h.Write(out.Pix)
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, out, &jpeg.Options{Quality: quality}); err != nil {
		return nil, err
	}
	return &Frame{JPEG: buf.Bytes(), Width: out.Bounds().Dx(), Height: out.Bounds().Dy(), Scale: scale, Hash: h.Sum64()}, nil
}

// Downscale 区域平均缩小，文字比最近邻清晰。
func Downscale(src *image.RGBA, w, h int) *image.RGBA {
	sw, sh := src.Bounds().Dx(), src.Bounds().Dy()
	dst := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		y0 := y * sh / h
		y1 := (y + 1) * sh / h
		if y1 <= y0 {
			y1 = y0 + 1
		}
		for x := 0; x < w; x++ {
			x0 := x * sw / w
			x1 := (x + 1) * sw / w
			if x1 <= x0 {
				x1 = x0 + 1
			}
			var r, g, b, n uint32
			for yy := y0; yy < y1; yy++ {
				row := src.Pix[yy*src.Stride:]
				for xx := x0; xx < x1; xx++ {
					p := row[xx*4:]
					r += uint32(p[0])
					g += uint32(p[1])
					b += uint32(p[2])
					n++
				}
			}
			d := dst.Pix[y*dst.Stride+x*4:]
			d[0], d[1], d[2], d[3] = uint8(r/n), uint8(g/n), uint8(b/n), 255
		}
	}
	return dst
}
