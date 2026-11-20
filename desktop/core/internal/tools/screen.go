package tools

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"

	"p2d/core/internal/perm"
	"p2d/core/internal/screen"
)

func registerScreen(r *Registry) {
	r.Add(&Tool{
		Name: "screen_capture",
		Description: "截取电脑屏幕，返回 JPEG 图片和坐标换算说明。为节省流量，默认缩放到最大宽度 1280。" +
			"点击前按返回的 scale 和偏移把截图坐标换算成屏幕坐标。",
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

	var sb strings.Builder
	ow, oh := frame.Width, frame.Height
	fmt.Fprintf(&sb, "显示器 %d：%dx%d，左上角位于屏幕坐标 (%d, %d)。截图尺寸 %dx%d，scale=%.4f。\n",
		d.Index, d.Width, d.Height, d.X, d.Y, ow, oh, scale)
	fmt.Fprintf(&sb, "屏幕坐标 = (截图x ÷ %.4f + %d, 截图y ÷ %.4f + %d)。", scale, d.X, scale, d.Y)
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
