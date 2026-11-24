package tools

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
	"sync"

	"p2d/core/internal/perm"
	"p2d/core/internal/screen"
)

func registerScreen(r *Registry) {
	r.Add(&Tool{
		Name: "screen_capture",
		Description: "截取电脑屏幕，返回 JPEG 图片和坐标换算说明。为节省流量，默认缩放到最大宽度 1280。" +
			"按截图点击时，input_mouse 传 coords=\"screenshot\" 并直接填截图上的像素坐标，电脑端按最近一次截图换算，不用自己计算。",
		InputSchema: object(map[string]prop{
			"display":   intg("显示器序号，默认 0（主显示器）"),
			"max_width": intg("截图最大宽度，默认 1280，最大 3840"),
			"quality":   intg("JPEG 质量 1-100，默认 70"),
		}),
		Category: perm.CatScreen, Kind: perm.Read, Handler: screenCapture,
	})
}

func screenCapture(ctx context.Context, raw json.RawMessage) (*Result, error) {
	var a struct {
		Display  int `json:"display"`
		MaxWidth int `json:"max_width"`
		Quality  int `json:"quality"`
	}
	if err := decode(raw, &a); err != nil {
		return nil, err
	}
	if a.MaxWidth <= 0 {
		a.MaxWidth = 1280
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
	if a.Display < 0 || a.Display >= len(displays) {
		return nil, fmt.Errorf("显示器序号 %d 不存在，共有 %d 个显示器", a.Display, len(displays))
	}
	d := displays[a.Display]
	img, err := screen.Capture(d.Bounds)
	if err != nil {
		return nil, err
	}
	frame, err := screen.Encode(img, a.MaxWidth, a.Quality)
	if err != nil {
		return nil, fmt.Errorf("JPEG 编码失败：%v", err)
	}
	scale := frame.Scale
	rememberShot(shotMap{scale: scale, x: d.X, y: d.Y, w: frame.Width, h: frame.Height})

	var sb strings.Builder
	ow, oh := frame.Width, frame.Height
	fmt.Fprintf(&sb, "显示器 %d：%dx%d，左上角位于屏幕坐标 (%d, %d)。截图尺寸 %dx%d，scale=%.4f。\n",
		d.Index, d.Width, d.Height, d.X, d.Y, ow, oh, scale)
	fmt.Fprintf(&sb, "屏幕坐标 = (截图x ÷ %.4f + %d, 截图y ÷ %.4f + %d)。", scale, d.X, scale, d.Y)
	sb.WriteString("\n点击截图上的位置：input_mouse 传 coords=\"screenshot\"，x / y 直接填截图上的像素坐标（不用换算）。")
	if len(displays) > 1 {
		sb.WriteString("\n全部显示器：")
		for _, x := range displays {
			fmt.Fprintf(&sb, "\n  %d：%dx%d @ (%d, %d)", x.Index, x.Width, x.Height, x.X, x.Y)
			if x.Primary {
				sb.WriteString(" 主显示器")
			}
		}
	}
	return &Result{Content: []Content{
		{Type: "image", Data: base64.StdEncoding.EncodeToString(frame.JPEG), MimeType: "image/jpeg"},
		{Type: "text", Text: sb.String()},
	}}, nil
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
