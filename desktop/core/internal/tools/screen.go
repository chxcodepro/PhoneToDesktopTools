package tools

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"math"
	"strings"
	"sync"

	"p2d/core/internal/perm"
	"p2d/core/internal/screen"
)

func registerScreen(r *Registry) {
	r.Add(&Tool{
		Name: "screen_capture",
		Description: "截取电脑屏幕，返回 JPEG 图片和坐标说明。默认截前台窗口所在的显示器，缩到约 1280 宽（不超过约 100 万像素，免得模型那边再缩放导致坐标偏）。" +
			"按截图点击时，input_mouse 传 coords=\"screenshot\" 并直接填截图上的像素坐标，电脑端按最近一次截图换算，不用自己计算。" +
			"要点的东西很小或点不准时，传 region（最近一次截图上的 x、y、宽、高）放大这一块再看，放大图同样可以按 coords=\"screenshot\" 点击。",
		InputSchema: object(map[string]prop{
			"display":   intg("显示器序号；不填为前台窗口所在的显示器"),
			"region":    {"type": "array", "description": "放大最近一次截图上的一块区域：[x, y, 宽, 高]（截图上的像素）", "items": map[string]any{"type": "integer"}, "minItems": 4, "maxItems": 4},
			"max_width": intg("截图最大宽度，默认约 1280，最大 3840"),
			"quality":   intg("JPEG 质量 1-100，默认 70"),
		}),
		Category: perm.CatScreen, Kind: perm.Read, Handler: screenCapture,
	})
}

// maxShotPixels 截图默认不超过的像素数：常见模型（Claude、Qwen 等）超过约 100 万像素会在服务端再缩小，模型给出的坐标就对不上了
const maxShotPixels = 1_000_000

func screenCapture(ctx context.Context, raw json.RawMessage) (*Result, error) {
	var a struct {
		Display  *int  `json:"display"`
		Region   []int `json:"region"`
		MaxWidth int   `json:"max_width"`
		Quality  int   `json:"quality"`
	}
	if err := decode(raw, &a); err != nil {
		return nil, err
	}
	if a.MaxWidth > 3840 {
		a.MaxWidth = 3840
	}
	if a.Quality <= 0 || a.Quality > 100 {
		a.Quality = 70
	}
	displays, err := screen.Displays()
	if err != nil {
		return nil, err
	}
	idx := screen.ActiveDisplay(displays)
	if a.Display != nil {
		idx = *a.Display
	}
	if idx < 0 || idx >= len(displays) {
		return nil, fmt.Errorf("显示器序号 %d 不存在，共有 %d 个显示器", idx, len(displays))
	}
	d := displays[idx]
	area := d.Bounds
	zoom := len(a.Region) > 0
	if zoom {
		if area, err = regionFromShot(a.Region); err != nil {
			return nil, err
		}
		if a.Display == nil {
			// 放大区域在哪块屏上，就按那块屏说明
			for _, x := range displays {
				if area.Overlaps(x.Bounds) {
					d = x
					break
				}
			}
		}
	}
	img, err := screen.Capture(area)
	if err != nil {
		return nil, err
	}
	maxW := a.MaxWidth
	if maxW <= 0 {
		maxW = defaultShotWidth(area.Dx(), area.Dy())
	}
	// 放大的小区域按整数倍放大：小按钮、小图标在图上变大，模型更容易点准
	up := 1
	if zoom && a.MaxWidth <= 0 {
		up = zoomFactor(img.Bounds().Dx(), img.Bounds().Dy(), maxW)
		if up > 1 {
			img = upscale(img, up)
		}
	}
	frame, err := screen.Encode(img, maxW, a.Quality)
	if err != nil {
		return nil, fmt.Errorf("JPEG 编码失败：%v", err)
	}
	scale := frame.Scale * float64(up)
	rememberShot(shotMap{scale: scale, x: area.Min.X, y: area.Min.Y, w: frame.Width, h: frame.Height})

	var sb strings.Builder
	ow, oh := frame.Width, frame.Height
	if zoom {
		fmt.Fprintf(&sb, "放大图：屏幕上 (%d, %d) 起 %dx%d 的区域（显示器 %d，缩放 %s）。截图尺寸 %dx%d，scale=%.4f。\n",
			area.Min.X, area.Min.Y, area.Dx(), area.Dy(), d.Index, pct(d.Scale), ow, oh, scale)
	} else {
		fmt.Fprintf(&sb, "显示器 %d：%dx%d，缩放 %s，左上角位于屏幕坐标 (%d, %d)。截图尺寸 %dx%d，scale=%.4f。\n",
			d.Index, d.Width, d.Height, pct(d.Scale), d.X, d.Y, ow, oh, scale)
	}
	fmt.Fprintf(&sb, "屏幕坐标 = (截图x ÷ %.4f + %d, 截图y ÷ %.4f + %d)。", scale, area.Min.X, scale, area.Min.Y)
	sb.WriteString("\n点击截图上的位置：input_mouse 传 coords=\"screenshot\"，x / y 直接填截图上的像素坐标（不用换算）。")
	if len(displays) > 1 {
		sb.WriteString("\n全部显示器（截别的屏传 display）：")
		for _, x := range displays {
			fmt.Fprintf(&sb, "\n  %d：%dx%d @ (%d, %d)，缩放 %s", x.Index, x.Width, x.Height, x.X, x.Y, pct(x.Scale))
			if x.Primary {
				sb.WriteString(" 主显示器")
			}
			if x.Index == d.Index {
				sb.WriteString(" ← 本次")
			}
		}
	}
	return &Result{Content: []Content{
		{Type: "image", Data: base64.StdEncoding.EncodeToString(frame.JPEG), MimeType: "image/jpeg"},
		{Type: "text", Text: sb.String()},
	}}, nil
}

func pct(scale float64) string {
	if scale <= 0 {
		scale = 1
	}
	return fmt.Sprintf("%.0f%%", scale*100)
}

// defaultShotWidth 默认宽度：最宽 1280，且总像素不超过 maxShotPixels；本来就小的不放大
func defaultShotWidth(w, h int) int {
	out := 1280
	if w > 0 && h > 0 {
		if lim := int(math.Sqrt(float64(maxShotPixels) * float64(w) / float64(h))); lim < out {
			out = lim
		}
	}
	return out
}

// zoomFactor 放大小区域的倍数（最多 3 倍，宽不超过 maxW，总像素不超过 maxShotPixels）
func zoomFactor(w, h, maxW int) int {
	if w <= 0 || h <= 0 {
		return 1
	}
	k := 3
	for k > 1 && (w*k > maxW || w*k*h*k > maxShotPixels) {
		k--
	}
	return k
}

// upscale 按整数倍放大（每个像素复制成 k×k 块，文字边缘不会变糊）
func upscale(src *image.RGBA, k int) *image.RGBA {
	b := src.Bounds()
	dst := image.NewRGBA(image.Rect(0, 0, b.Dx()*k, b.Dy()*k))
	for y := 0; y < b.Dy(); y++ {
		o := src.PixOffset(b.Min.X, b.Min.Y+y)
		row := src.Pix[o : o+b.Dx()*4]
		line := dst.Pix[y*k*dst.Stride : y*k*dst.Stride+b.Dx()*k*4]
		for x := 0; x < b.Dx(); x++ {
			px := row[x*4 : x*4+4]
			for i := 0; i < k; i++ {
				copy(line[(x*k+i)*4:], px)
			}
		}
		for i := 1; i < k; i++ {
			copy(dst.Pix[(y*k+i)*dst.Stride:], line)
		}
	}
	return dst
}

// regionFromShot 把最近一次截图上的 [x, y, 宽, 高] 换算成屏幕上的区域
func regionFromShot(r []int) (image.Rectangle, error) {
	if len(r) != 4 || r[2] <= 0 || r[3] <= 0 {
		return image.Rectangle{}, errors.New("region 要填 [x, y, 宽, 高]，是最近一次截图上的像素，宽和高大于 0")
	}
	x0, y0, err := fromShot(r[0], r[1])
	if err != nil {
		return image.Rectangle{}, err
	}
	x1, y1, err := fromShotClamped(r[0]+r[2], r[1]+r[3])
	if err != nil {
		return image.Rectangle{}, err
	}
	rect := image.Rect(x0, y0, x1, y1)
	if rect.Dx() < 8 || rect.Dy() < 8 {
		return image.Rectangle{}, errors.New("region 太小了：至少放大屏幕上 8x8 像素的区域")
	}
	return rect, nil
}

// shotMap 最近一次截图和屏幕坐标的换算关系（input_mouse 的 coords=screenshot 用）
type shotMap struct {
	scale float64
	x, y  int
	w, h  int
}

var (
	shotMu   sync.Mutex
	lastShot *shotMap
)

func rememberShot(m shotMap) {
	shotMu.Lock()
	defer shotMu.Unlock()
	lastShot = &m
}

// fromShotClamped 同 fromShot，但超出截图范围的坐标先收到截图边上（region 的右下角用）
func fromShotClamped(x, y int) (int, int, error) {
	shotMu.Lock()
	m := lastShot
	shotMu.Unlock()
	if m != nil {
		x, y = clampInt(x, 0, m.w), clampInt(y, 0, m.h)
	}
	return fromShot(x, y)
}

func clampInt(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

// fromRelative 把 0–1000 的相对位置（左上角 0,0，右下角 1000,1000）换算成屏幕坐标：有的模型习惯这样给坐标
func fromRelative(x, y int) (int, int, error) {
	shotMu.Lock()
	m := lastShot
	shotMu.Unlock()
	if m == nil {
		return 0, 0, errors.New("还没有截图：coords=relative 要先用 screen_capture 截图")
	}
	if x < 0 || y < 0 || x > 1000 || y > 1000 {
		return 0, 0, fmt.Errorf("坐标 (%d, %d) 超出范围：coords=relative 时 x、y 是 0–1000 的相对位置", x, y)
	}
	return fromShot(int(math.Round(float64(x)*float64(m.w)/1000)), int(math.Round(float64(y)*float64(m.h)/1000)))
}

// fromShot 把截图上的坐标换算成屏幕坐标
func fromShot(x, y int) (int, int, error) {
	shotMu.Lock()
	m := lastShot
	shotMu.Unlock()
	if m == nil || m.scale <= 0 {
		return 0, 0, errors.New("还没有截图：coords=screenshot 要先用 screen_capture 截图")
	}
	if x < 0 || y < 0 || x > m.w || y > m.h {
		return 0, 0, fmt.Errorf("坐标 (%d, %d) 超出了截图范围（%dx%d）：coords=screenshot 时填截图上的像素坐标", x, y, m.w, m.h)
	}
	return int(math.Round(float64(x)/m.scale)) + m.x, int(math.Round(float64(y)/m.scale)) + m.y, nil
}
