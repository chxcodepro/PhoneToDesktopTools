//go:build darwin && cgo

package input

// Mac 键鼠：用 CoreGraphics 的 CGEventPost 发出系统级事件（坐标是全局坐标，单位是点，和 screen 包一致）。
// 需要「辅助功能」权限，没有权限时系统会悄悄丢掉事件，所以每次先检查，没权限就返回说明。
//
// 和 Windows / Linux 不同的地方：
//   - 按住左键移动要发「拖动」事件，普通移动事件在 Mac 上不算拖动；
//   - 双击要由发送方自己在事件里写上「第几次点击」，否则连点两下只是两次单击；
//   - 输入文字直接把 Unicode 字符串放进键盘事件，中文等不依赖输入法。

/*
#cgo CFLAGS: -mmacosx-version-min=10.13
#cgo LDFLAGS: -framework ApplicationServices -framework CoreGraphics -framework CoreFoundation
#include <ApplicationServices/ApplicationServices.h>
#include <CoreFoundation/CoreFoundation.h>

// 有没有辅助功能权限
static int p2d_trusted(void) {
	return AXIsProcessTrusted() ? 1 : 0;
}

// 弹出系统的辅助功能授权提示，并把程序加进「辅助功能」列表
static void p2d_prompt_trust(void) {
	const void *keys[] = { kAXTrustedCheckOptionPrompt };
	const void *vals[] = { kCFBooleanTrue };
	CFDictionaryRef opts = CFDictionaryCreate(NULL, keys, vals, 1,
		&kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
	if (opts == NULL) return;
	AXIsProcessTrustedWithOptions(opts);
	CFRelease(opts);
}

static int p2d_cursor_pos(double *x, double *y) {
	CGEventRef e = CGEventCreate(NULL);
	if (e == NULL) return 0;
	CGPoint p = CGEventGetLocation(e);
	CFRelease(e);
	*x = p.x;
	*y = p.y;
	return 1;
}

// 鼠标事件。kind：0 移动，1 按下，2 松开，3 拖动（按住某个键时移动）；button：0 左，1 右，2 中；
// clicks > 0 时写入「第几次点击」（双击要靠它）。返回 0 成功
static int p2d_mouse(int kind, int button, double x, double y, int clicks) {
	CGMouseButton b = kCGMouseButtonLeft;
	if (button == 1) b = kCGMouseButtonRight;
	else if (button == 2) b = kCGMouseButtonCenter;
	CGEventType t;
	switch (kind) {
	case 1:
		t = button == 0 ? kCGEventLeftMouseDown : (button == 1 ? kCGEventRightMouseDown : kCGEventOtherMouseDown);
		break;
	case 2:
		t = button == 0 ? kCGEventLeftMouseUp : (button == 1 ? kCGEventRightMouseUp : kCGEventOtherMouseUp);
		break;
	case 3:
		t = button == 0 ? kCGEventLeftMouseDragged : (button == 1 ? kCGEventRightMouseDragged : kCGEventOtherMouseDragged);
		break;
	default:
		t = kCGEventMouseMoved;
		break;
	}
	CGEventRef e = CGEventCreateMouseEvent(NULL, t, CGPointMake(x, y), b);
	if (e == NULL) return -1;
	if (clicks > 0) CGEventSetIntegerValueField(e, kCGMouseEventClickState, (int64_t)clicks);
	CGEventPost(kCGHIDEventTap, e);
	CFRelease(e);
	return 0;
}

// 滚轮（按行），lines 为正向上。CGEventCreateScrollWheelEvent 是变参函数，cgo 不能直接调用，在这里包一层
static int p2d_scroll(int lines) {
	CGEventRef e = CGEventCreateScrollWheelEvent(NULL, kCGScrollEventUnitLine, 1, (int32_t)lines);
	if (e == NULL) return -1;
	CGEventPost(kCGHIDEventTap, e);
	CFRelease(e);
	return 0;
}

// 按下或松开一个键，flags 是当前按着的修饰键（Command、Shift 等）
static int p2d_key(int code, int down, unsigned long long flags) {
	CGEventRef e = CGEventCreateKeyboardEvent(NULL, (CGKeyCode)code, down ? true : false);
	if (e == NULL) return -1;
	CGEventSetFlags(e, (CGEventFlags)flags);
	CGEventPost(kCGHIDEventTap, e);
	CFRelease(e);
	return 0;
}

// 输入一段 Unicode（UTF-16）文字：按下、松开各一个带文字的键盘事件
static int p2d_unicode(const UniChar *s, int n) {
	CGEventRef d = CGEventCreateKeyboardEvent(NULL, 0, true);
	CGEventRef u = CGEventCreateKeyboardEvent(NULL, 0, false);
	if (d == NULL || u == NULL) {
		if (d != NULL) CFRelease(d);
		if (u != NULL) CFRelease(u);
		return -1;
	}
	CGEventSetFlags(d, (CGEventFlags)0);
	CGEventSetFlags(u, (CGEventFlags)0);
	CGEventKeyboardSetUnicodeString(d, (UniCharCount)n, s);
	CGEventKeyboardSetUnicodeString(u, (UniCharCount)n, s);
	CGEventPost(kCGHIDEventTap, d);
	CGEventPost(kCGHIDEventTap, u);
	CFRelease(d);
	CFRelease(u);
	return 0;
}

static unsigned long long p2d_flag_control(void) { return (unsigned long long)kCGEventFlagMaskControl; }
static unsigned long long p2d_flag_shift(void) { return (unsigned long long)kCGEventFlagMaskShift; }
static unsigned long long p2d_flag_option(void) { return (unsigned long long)kCGEventFlagMaskAlternate; }
static unsigned long long p2d_flag_command(void) { return (unsigned long long)kCGEventFlagMaskCommand; }
*/
import "C"

import (
	"errors"
	"fmt"
	"math"
	"strings"
	"sync"
	"time"
	"unicode/utf16"
	"unsafe"
)

var (
	mu         sync.Mutex
	promptOnce sync.Once
	// 按着的鼠标键（按住时移动要发拖动事件）
	held = map[Button]bool{}
	// 上一次按下鼠标的时间、位置、按键和连击次数，用来算双击
	lastDown      time.Time
	lastDownX     float64
	lastDownY     float64
	lastDownBtn   Button
	clickCount    int
	currentClicks = map[Button]int{}
	// 最近一次 Move 的位置：移动事件由系统异步处理，紧接着按下时直接用这个位置，免得点在旧位置上
	movedAt time.Time
	movedX  float64
	movedY  float64
)

// 和系统默认的双击间隔差不多；连续点击时两次按下离得超过 4 个点就不算双击
const (
	doubleClickTime = 500 * time.Millisecond
	doubleClickDist = 4
)

var errNoAccessibility = errors.New("没有辅助功能权限，不能控制键鼠：请在 Mac 的「系统设置 → 隐私与安全性 → 辅助功能」（旧版系统在「系统偏好设置 → 安全性与隐私 → 隐私」）里允许 P2D，然后重新打开 P2D")

// ready 检查辅助功能权限；第一次没权限时弹出系统提示
func ready() error {
	if C.p2d_trusted() != 0 {
		return nil
	}
	promptOnce.Do(func() { C.p2d_prompt_trust() })
	return errNoAccessibility
}

func cursor() (float64, float64) {
	var x, y C.double
	if C.p2d_cursor_pos(&x, &y) == 0 {
		return 0, 0
	}
	return float64(x), float64(y)
}

func buttonIndex(b Button) C.int {
	switch b {
	case Right:
		return 1
	case Middle:
		return 2
	}
	return 0
}

func mouse(kind int, b Button, x, y float64, clicks int) error {
	if C.p2d_mouse(C.int(kind), buttonIndex(b), C.double(x), C.double(y), C.int(clicks)) != 0 {
		return errors.New("发送鼠标事件失败")
	}
	return nil
}

// Move 把鼠标移到屏幕坐标 (x, y)；按着鼠标键时发拖动事件。
func Move(x, y int) error {
	mu.Lock()
	defer mu.Unlock()
	if err := ready(); err != nil {
		return err
	}
	movedAt, movedX, movedY = time.Now(), float64(x), float64(y)
	for _, b := range []Button{Left, Right, Middle} {
		if held[b] {
			return mouse(3, b, float64(x), float64(y), currentClicks[b])
		}
	}
	return mouse(0, Left, float64(x), float64(y), 0)
}

// Press 在鼠标当前位置按下或松开鼠标键。
func Press(b Button, down bool) error {
	mu.Lock()
	defer mu.Unlock()
	if err := ready(); err != nil {
		return err
	}
	x, y := cursor()
	if time.Since(movedAt) < time.Second {
		x, y = movedX, movedY
	}
	if down {
		now := time.Now()
		if b == lastDownBtn && now.Sub(lastDown) <= doubleClickTime && math.Hypot(x-lastDownX, y-lastDownY) <= doubleClickDist {
			clickCount++
		} else {
			clickCount = 1
		}
		lastDown, lastDownX, lastDownY, lastDownBtn = now, x, y, b
		currentClicks[b] = clickCount
		held[b] = true
		return mouse(1, b, x, y, clickCount)
	}
	clicks := currentClicks[b]
	if clicks == 0 {
		clicks = 1
	}
	held[b] = false
	return mouse(2, b, x, y, clicks)
}

// Scroll 滚轮，dy 为正向上。一格按 3 行滚动，和 Windows 默认的一格差不多。
func Scroll(dy int) error {
	mu.Lock()
	defer mu.Unlock()
	if err := ready(); err != nil {
		return err
	}
	step := 1
	if dy < 0 {
		step, dy = -1, -dy
	}
	for i := 0; i < dy; i++ {
		if C.p2d_scroll(C.int(step*3)) != 0 {
			return errors.New("发送滚轮事件失败")
		}
		time.Sleep(10 * time.Millisecond)
	}
	return nil
}

// Mac 的虚拟键码（按美式键盘的位置，Carbon 的 kVK_*）
var keyCodes = map[string]int{
	"a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
	"b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
	"1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29,
	"]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41,
	"\\": 42, ",": 43, "/": 44, "n": 45, "m": 46, ".": 47, "`": 50,
	"enter": 36, "tab": 48, "space": 49, "backspace": 51, "esc": 53,
	"win": 55, "shift": 56, "capslock": 57, "alt": 58, "ctrl": 59,
	// Mac 键盘没有 Insert，对应位置是 Help
	"insert": 114,
	"home":   115, "pageup": 116, "delete": 117, "end": 119, "pagedown": 121,
	"left": 123, "right": 124, "down": 125, "up": 126,
	"f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100,
	"f9": 101, "f10": 109, "f11": 103, "f12": 111, "f13": 105, "f14": 107, "f15": 113,
	"f16": 106, "f17": 64, "f18": 79, "f19": 80, "f20": 90,
}

// 要按 Shift 才能打出来的符号 → 对应的键
var shifted = map[string]string{
	"!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0",
	"_": "-", "+": "=", "{": "[", "}": "]", "|": "\\", ":": ";", "\"": "'", "<": ",", ">": ".", "?": "/", "~": "`",
}

func modifierFlag(k string) uint64 {
	switch k {
	case "ctrl":
		return uint64(C.p2d_flag_control())
	case "shift":
		return uint64(C.p2d_flag_shift())
	case "alt":
		return uint64(C.p2d_flag_option())
	case "win":
		return uint64(C.p2d_flag_command())
	}
	return 0
}

func key(code int, down bool, flags uint64) error {
	d := 0
	if down {
		d = 1
	}
	if C.p2d_key(C.int(code), C.int(d), C.ulonglong(flags)) != 0 {
		return errors.New("发送键盘事件失败")
	}
	return nil
}

// typeChunk 输入一段 UTF-16 文字。部分程序一次只收 20 个字符左右，所以分段发，代理对（表情等）不拆开。
func typeChunk(u []uint16) error {
	const max = 16
	for len(u) > 0 {
		n := len(u)
		if n > max {
			n = max
			if u[n-1] >= 0xD800 && u[n-1] < 0xDC00 {
				n-- // 高位代理留到下一段，和低位代理一起发
			}
		}
		if C.p2d_unicode((*C.UniChar)(unsafe.Pointer(&u[0])), C.int(n)) != 0 {
			return errors.New("发送键盘事件失败")
		}
		u = u[n:]
		time.Sleep(5 * time.Millisecond)
	}
	return nil
}

// TypeText 输入文字（支持中文，不依赖输入法）。换行、Tab 按真实的回车、Tab 键发送。
func TypeText(s string) error {
	mu.Lock()
	defer mu.Unlock()
	if err := ready(); err != nil {
		return err
	}
	s = strings.ReplaceAll(s, "\r\n", "\n")
	var buf []uint16
	flush := func() error {
		if len(buf) == 0 {
			return nil
		}
		err := typeChunk(buf)
		buf = buf[:0]
		return err
	}
	for _, r := range s {
		if r == '\n' || r == '\t' {
			if err := flush(); err != nil {
				return err
			}
			code := keyCodes["enter"]
			if r == '\t' {
				code = keyCodes["tab"]
			}
			if err := key(code, true, 0); err != nil {
				return err
			}
			if err := key(code, false, 0); err != nil {
				return err
			}
			continue
		}
		buf = append(buf, utf16.Encode([]rune{r})...)
	}
	return flush()
}

// Combo 按下组合键：依次按下，再反序松开。win / cmd 对应 Command 键，alt 对应 Option 键。
func Combo(keys []string) error {
	mu.Lock()
	defer mu.Unlock()
	if err := ready(); err != nil {
		return err
	}
	type press struct {
		code int
		flag uint64
	}
	var seq []press
	for _, k := range keys {
		if base, ok := shifted[k]; ok {
			seq = append(seq, press{keyCodes["shift"], modifierFlag("shift")})
			k = base
		}
		code, ok := keyCodes[k]
		if !ok {
			return fmt.Errorf("不认识的按键：%s", k)
		}
		seq = append(seq, press{code, modifierFlag(k)})
	}
	// 按下时修饰键标记逐个累加，松开时逐个去掉，前台程序看到的就是正常的组合键
	var flags uint64
	for _, p := range seq {
		flags |= p.flag
		if err := key(p.code, true, flags); err != nil {
			return err
		}
	}
	for i := len(seq) - 1; i >= 0; i-- {
		p := seq[i]
		flags &^= p.flag // 松开修饰键的事件里已经不带它自己
		if err := key(p.code, false, flags); err != nil {
			return err
		}
	}
	return nil
}
