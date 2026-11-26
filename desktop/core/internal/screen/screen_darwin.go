//go:build darwin && cgo

package screen

// Mac 截图：屏幕坐标用 CoreGraphics 的全局坐标（单位是「点」，左上角为原点，主显示器左上角为 (0, 0)），
// 键鼠（input 包）用的是同一套坐标。Retina 屏一个点是 2×2 个像素，截到的像素图缩到和请求区域（点）同样大小，
// 这样截图上的像素和屏幕坐标一一对应，和 Windows、Linux 的约定一致。
//
// 截图优先用 CGDisplayCreateImageForRect：它在新版 SDK 里标为过时（macOS 15 的 SDK 直接不让编译），
// 所以运行时用 dlsym 取；取不到或返回空（新系统上已不可用）时改用系统自带的 screencapture 命令。

/*
#cgo CFLAGS: -mmacosx-version-min=10.13
#cgo LDFLAGS: -framework CoreGraphics -framework CoreFoundation
#include <CoreGraphics/CoreGraphics.h>
#include <CoreFoundation/CoreFoundation.h>
#include <dlfcn.h>
#include <stdbool.h>

typedef CGImageRef (*p2d_rect_image_fn)(CGDirectDisplayID, CGRect);
typedef bool (*p2d_bool_fn)(void);

// 显示器列表：每个显示器 6 个数（x, y, 宽, 高, 像素/点, 是否主显示器），返回个数，失败返回 -1
static int p2d_displays(double *out, int max) {
	CGDirectDisplayID ids[16];
	uint32_t n = 0;
	if (CGGetActiveDisplayList(16, ids, &n) != kCGErrorSuccess) return -1;
	if ((int)n > max) n = (uint32_t)max;
	CGDirectDisplayID mainID = CGMainDisplayID();
	for (uint32_t i = 0; i < n; i++) {
		CGRect b = CGDisplayBounds(ids[i]);
		double scale = 1;
		CGDisplayModeRef m = CGDisplayCopyDisplayMode(ids[i]);
		if (m != NULL) {
			size_t pw = CGDisplayModeGetPixelWidth(m);
			size_t w = CGDisplayModeGetWidth(m);
			if (w > 0 && pw > 0) scale = (double)pw / (double)w;
			CGDisplayModeRelease(m);
		}
		double *o = out + i * 6;
		o[0] = b.origin.x;
		o[1] = b.origin.y;
		o[2] = b.size.width;
		o[3] = b.size.height;
		o[4] = scale;
		o[5] = ids[i] == mainID ? 1 : 0;
	}
	return (int)n;
}

// 有没有屏幕录制权限：10.15 起才有这项权限，之前的系统没有这个函数，视为允许
static int p2d_screen_allowed(void) {
	p2d_bool_fn f = (p2d_bool_fn)dlsym(RTLD_DEFAULT, "CGPreflightScreenCaptureAccess");
	if (f == NULL) return 1;
	return f() ? 1 : 0;
}

// 请求屏幕录制权限：系统弹窗并把程序加进「屏幕录制」列表（每个程序只弹一次）
static void p2d_screen_request(void) {
	p2d_bool_fn f = (p2d_bool_fn)dlsym(RTLD_DEFAULT, "CGRequestScreenCaptureAccess");
	if (f != NULL) f();
}

// 截取全局坐标 (x, y, w, h) 的区域，缩放后画进 outW×outH 的 RGBA 缓冲区（每行 outW*4 字节）。
// 返回 0 成功；1 表示这个方法不可用（应改用 screencapture）；-1 其他错误
static int p2d_capture(double x, double y, double w, double h, int outW, int outH, void *dst) {
	p2d_rect_image_fn create = (p2d_rect_image_fn)dlsym(RTLD_DEFAULT, "CGDisplayCreateImageForRect");
	if (create == NULL) return 1;
	CGDirectDisplayID ids[16];
	uint32_t n = 0;
	if (CGGetActiveDisplayList(16, ids, &n) != kCGErrorSuccess || n == 0) return -1;
	CGColorSpaceRef cs = CGColorSpaceCreateDeviceRGB();
	if (cs == NULL) return -1;
	CGContextRef ctx = CGBitmapContextCreate(dst, (size_t)outW, (size_t)outH, 8, (size_t)outW * 4, cs,
		(CGBitmapInfo)kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big);
	CGColorSpaceRelease(cs);
	if (ctx == NULL) return -1;
	CGContextSetInterpolationQuality(ctx, kCGInterpolationMedium);
	CGRect want = CGRectMake(x, y, w, h);
	double kx = (double)outW / w, ky = (double)outH / h;
	int drawn = 0;
	// 请求的区域可能跨几块显示器：逐块截取，画到对应位置
	for (uint32_t i = 0; i < n; i++) {
		CGRect b = CGDisplayBounds(ids[i]);
		CGRect in = CGRectIntersection(want, b);
		if (CGRectIsNull(in) || CGRectIsEmpty(in)) continue;
		CGRect local = CGRectMake(in.origin.x - b.origin.x, in.origin.y - b.origin.y, in.size.width, in.size.height);
		CGImageRef img = create(ids[i], local);
		if (img == NULL) continue;
		// 位图上下文的原点在左下角，缓冲区第一行是最上面一行
		CGRect dest = CGRectMake((in.origin.x - x) * kx, (double)outH - (in.origin.y - y + in.size.height) * ky,
			in.size.width * kx, in.size.height * ky);
		CGContextDrawImage(ctx, dest, img);
		CGImageRelease(img);
		drawn++;
	}
	CGContextRelease(ctx);
	return drawn > 0 ? 0 : 1;
}

// 鼠标位置（全局坐标）
static int p2d_cursor(double *x, double *y) {
	CGEventRef e = CGEventCreate(NULL);
	if (e == NULL) return 0;
	CGPoint p = CGEventGetLocation(e);
	CFRelease(e);
	*x = p.x;
	*y = p.y;
	return 1;
}
*/
import "C"

import (
	"errors"
	"fmt"
	"image"
	"image/draw"
	"image/png"
	"math"
	"os"
	"os/exec"
	"sync"
	"unsafe"
)

var requestOnce sync.Once

// errNoScreenPermission 没有屏幕录制权限时的提示
var errNoScreenPermission = errors.New("没有屏幕录制权限：请在 Mac 的「系统设置 → 隐私与安全性 → 屏幕录制」（旧版系统在「系统偏好设置 → 安全性与隐私 → 隐私」）里允许 P2D，然后重新打开 P2D")

// Init Mac 下无需初始化。
func Init() {}

// Displays 返回所有显示器（坐标单位是点），主显示器排在第 0 个。
func Displays() ([]Display, error) {
	var buf [16 * 6]C.double
	n := int(C.p2d_displays(&buf[0], 16))
	if n <= 0 {
		return nil, errors.New("读取显示器列表失败")
	}
	var out []Display
	for i := 0; i < n; i++ {
		o := buf[i*6 : i*6+6]
		r := image.Rect(int(math.Round(float64(o[0]))), int(math.Round(float64(o[1]))),
			int(math.Round(float64(o[0]+o[2]))), int(math.Round(float64(o[1]+o[3]))))
		d := newDisplay(0, r, o[5] != 0)
		if s := float64(o[4]); s > 0 {
			d.Scale = s
		}
		if d.Primary {
			out = append([]Display{d}, out...)
		} else {
			out = append(out, d)
		}
	}
	for i := range out {
		out[i].Index = i
	}
	return out, nil
}

// Capture 截取一块区域（全局坐标，单位是点），返回和区域同样大小的图片。
func Capture(r image.Rectangle) (*image.RGBA, error) {
	w, h := r.Dx(), r.Dy()
	if w <= 0 || h <= 0 {
		return nil, errors.New("截图区域为空")
	}
	if C.p2d_screen_allowed() == 0 {
		requestOnce.Do(func() { C.p2d_screen_request() })
		return nil, errNoScreenPermission
	}
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	rc := C.p2d_capture(C.double(r.Min.X), C.double(r.Min.Y), C.double(w), C.double(h), C.int(w), C.int(h), unsafe.Pointer(&img.Pix[0]))
	switch rc {
	case 0:
		// 不在任何显示器上的部分是透明的，统一改成不透明的黑色
		for i := 3; i < len(img.Pix); i += 4 {
			img.Pix[i] = 255
		}
		return img, nil
	case 1:
		return captureCommand(r)
	}
	return nil, errors.New("截图失败")
}

// captureCommand 用系统自带的 screencapture 截图（-x 不出声音，-R 按全局坐标截取区域），再缩到区域大小。
func captureCommand(r image.Rectangle) (*image.RGBA, error) {
	f, err := os.CreateTemp("", "p2d-shot-*.png")
	if err != nil {
		return nil, err
	}
	name := f.Name()
	f.Close()
	defer os.Remove(name)
	arg := fmt.Sprintf("%d,%d,%d,%d", r.Min.X, r.Min.Y, r.Dx(), r.Dy())
	if out, err := exec.Command("/usr/sbin/screencapture", "-x", "-R", arg, "-t", "png", name).CombinedOutput(); err != nil {
		return nil, fmt.Errorf("screencapture 截图失败：%v %s", err, out)
	}
	pf, err := os.Open(name)
	if err != nil {
		return nil, err
	}
	defer pf.Close()
	src, err := png.Decode(pf)
	if err != nil {
		// 没有屏幕录制权限时 screencapture 可能不生成文件
		return nil, fmt.Errorf("读取截图失败（%v）；%v", err, errNoScreenPermission)
	}
	b := src.Bounds()
	rgba := image.NewRGBA(image.Rect(0, 0, b.Dx(), b.Dy()))
	draw.Draw(rgba, rgba.Bounds(), src, b.Min, draw.Src)
	if b.Dx() == r.Dx() && b.Dy() == r.Dy() {
		return rgba, nil
	}
	return Downscale(rgba, r.Dx(), r.Dy()), nil
}

// CursorPos 鼠标在屏幕中的位置（全局坐标，单位是点）。
func CursorPos() (x, y int, ok bool) {
	var cx, cy C.double
	if C.p2d_cursor(&cx, &cy) == 0 {
		return 0, 0, false
	}
	return int(math.Round(float64(cx))), int(math.Round(float64(cy))), true
}
