//go:build linux

package screen

import (
	"errors"
	"fmt"
	"image"
	"os"
	"sync"

	"github.com/jezek/xgb"
	"github.com/jezek/xgb/xinerama"
	"github.com/jezek/xgb/xproto"
)

var (
	connMu sync.Mutex
	conn   *xgb.Conn
)

// Init Linux 下无需初始化。
func Init() {}

// X 返回共享的 X11 连接（断开后自动重连）。input 包也复用它。
func X() (*xgb.Conn, error) {
	connMu.Lock()
	defer connMu.Unlock()
	if conn != nil {
		return conn, nil
	}
	if os.Getenv("WAYLAND_DISPLAY") != "" && os.Getenv("DISPLAY") == "" {
		return nil, errors.New("当前是 Wayland 会话，暂不支持截图和键鼠控制，请在登录界面选择 X11（Xorg）会话")
	}
	display := os.Getenv("DISPLAY")
	if display == "" {
		display = ":0"
	}
	c, err := xgb.NewConnDisplay(display)
	if err != nil {
		return nil, fmt.Errorf("无法连接 X11 显示服务 %s：%v", display, err)
	}
	conn = c
	return conn, nil
}

// ResetX 出错时丢弃连接，下次重连。
func ResetX() {
	connMu.Lock()
	defer connMu.Unlock()
	if conn != nil {
		conn.Close()
		conn = nil
	}
}

// Displays 返回所有显示器（Xinerama），主显示器排在第 0 个。
func Displays() ([]Display, error) {
	c, err := X()
	if err != nil {
		return nil, err
	}
	if xinerama.Init(c) == nil {
		if reply, err := xinerama.QueryScreens(c).Reply(); err == nil && len(reply.ScreenInfo) > 0 {
			out := make([]Display, 0, len(reply.ScreenInfo))
			for i, s := range reply.ScreenInfo {
				r := image.Rect(int(s.XOrg), int(s.YOrg), int(s.XOrg)+int(s.Width), int(s.YOrg)+int(s.Height))
				out = append(out, newDisplay(i, r, i == 0))
			}
			return out, nil
		}
	}
	scr := xproto.Setup(c).DefaultScreen(c)
	return []Display{newDisplay(0, image.Rect(0, 0, int(scr.WidthInPixels), int(scr.HeightInPixels)), true)}, nil
}

// Capture 截取虚拟桌面中的一块区域。
func Capture(r image.Rectangle) (*image.RGBA, error) {
	c, err := X()
	if err != nil {
		return nil, err
	}
	setup := xproto.Setup(c)
	scr := setup.DefaultScreen(c)
	w, h := r.Dx(), r.Dy()
	if w <= 0 || h <= 0 {
		return nil, errors.New("截图区域为空")
	}
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	// 分块获取，避免单个回复过大
	const band = 256
	for y0 := 0; y0 < h; y0 += band {
		bh := band
		if y0+bh > h {
			bh = h - y0
		}
		reply, err := xproto.GetImage(c, xproto.ImageFormatZPixmap, xproto.Drawable(scr.Root),
			int16(r.Min.X), int16(r.Min.Y+y0), uint16(w), uint16(bh), 0xffffffff).Reply()
		if err != nil {
			ResetX()
			return nil, fmt.Errorf("X11 截图失败：%v", err)
		}
		if err := copyPixels(img, reply.Data, setup, reply.Depth, w, bh, y0); err != nil {
			return nil, err
		}
	}
	return img, nil
}

func copyPixels(img *image.RGBA, data []byte, setup *xproto.SetupInfo, depth byte, w, h, y0 int) error {
	bpp := 0
	pad := 32
	for _, f := range setup.PixmapFormats {
		if f.Depth == depth {
			bpp = int(f.BitsPerPixel)
			pad = int(f.ScanlinePad)
		}
	}
	if bpp != 32 && bpp != 24 {
		return fmt.Errorf("不支持的像素格式：深度 %d，%d 位/像素", depth, bpp)
	}
	bytesPP := bpp / 8
	stride := ((w*bpp + pad - 1) / pad) * pad / 8
	lsb := setup.ImageByteOrder == xproto.ImageOrderLSBFirst
	for y := 0; y < h; y++ {
		row := data[y*stride:]
		dst := img.Pix[(y0+y)*img.Stride:]
		for x := 0; x < w; x++ {
			s := row[x*bytesPP:]
			var b, g, rr byte
			if lsb {
				b, g, rr = s[0], s[1], s[2]
			} else if bytesPP == 4 {
				rr, g, b = s[1], s[2], s[3]
			} else {
				rr, g, b = s[0], s[1], s[2]
			}
			d := dst[x*4:]
			d[0], d[1], d[2], d[3] = rr, g, b, 255
		}
	}
	return nil
}
