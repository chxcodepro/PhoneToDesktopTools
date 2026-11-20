//go:build linux

package input

import (
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/jezek/xgb"
	"github.com/jezek/xgb/xproto"
	"github.com/jezek/xgb/xtest"

	"p2d/core/internal/screen"
)

var (
	mu          sync.Mutex
	xtestReady  *xgb.Conn
	keymapCache *keymap
)

type keymap struct {
	min, max xproto.Keycode
	perCode  int
	syms     []xproto.Keysym
}

func conn() (*xgb.Conn, xproto.Window, error) {
	c, err := screen.X()
	if err != nil {
		return nil, 0, err
	}
	if xtestReady != c {
		if err := xtest.Init(c); err != nil {
			return nil, 0, fmt.Errorf("X11 服务不支持 XTest 扩展，无法模拟键鼠：%v", err)
		}
		xtestReady = c
		keymapCache = nil
	}
	root := xproto.Setup(c).DefaultScreen(c).Root
	return c, root, nil
}

func fake(c *xgb.Conn, root xproto.Window, typ byte, detail byte, x, y int16) error {
	if err := xtest.FakeInputChecked(c, typ, detail, 0, root, x, y, 0).Check(); err != nil {
		screen.ResetX()
		return fmt.Errorf("XTest 调用失败：%v", err)
	}
	return nil
}

// Move 把鼠标移到屏幕坐标 (x, y)。
func Move(x, y int) error {
	mu.Lock()
	defer mu.Unlock()
	c, root, err := conn()
	if err != nil {
		return err
	}
	return fake(c, root, xproto.MotionNotify, 0, int16(x), int16(y))
}

func buttonCode(b Button) byte {
	switch b {
	case Right:
		return 3
	case Middle:
		return 2
	default:
		return 1
	}
}

// Press 按下或松开鼠标键。
func Press(b Button, down bool) error {
	mu.Lock()
	defer mu.Unlock()
	c, root, err := conn()
	if err != nil {
		return err
	}
	typ := byte(xproto.ButtonRelease)
	if down {
		typ = xproto.ButtonPress
	}
	return fake(c, root, typ, buttonCode(b), 0, 0)
}

// Scroll 滚轮，dy 为正向上（X11 中按键 4 向上、5 向下）。
func Scroll(dy int) error {
	mu.Lock()
	defer mu.Unlock()
	c, root, err := conn()
	if err != nil {
		return err
	}
	btn := byte(4)
	if dy < 0 {
		btn, dy = 5, -dy
	}
	for i := 0; i < dy; i++ {
		if err := fake(c, root, xproto.ButtonPress, btn, 0, 0); err != nil {
			return err
		}
		if err := fake(c, root, xproto.ButtonRelease, btn, 0, 0); err != nil {
			return err
		}
	}
	return nil
}

func loadKeymap(c *xgb.Conn) (*keymap, error) {
	if keymapCache != nil {
		return keymapCache, nil
	}
	setup := xproto.Setup(c)
	count := byte(int(setup.MaxKeycode) - int(setup.MinKeycode) + 1)
	reply, err := xproto.GetKeyboardMapping(c, setup.MinKeycode, count).Reply()
	if err != nil {
		return nil, fmt.Errorf("读取键盘映射失败：%v", err)
	}
	keymapCache = &keymap{min: setup.MinKeycode, max: setup.MaxKeycode, perCode: int(reply.KeysymsPerKeycode), syms: reply.Keysyms}
	return keymapCache, nil
}

// find 查找能产生该 keysym 的键码，以及是否需要 Shift。
func (k *keymap) find(sym xproto.Keysym) (xproto.Keycode, bool, bool) {
	for i := 0; i*k.perCode < len(k.syms); i++ {
		for j := 0; j < k.perCode && j < 2; j++ {
			if k.syms[i*k.perCode+j] == sym {
				return xproto.Keycode(int(k.min) + i), j == 1, true
			}
		}
	}
	return 0, false, false
}

// spare 找一个没有绑定任何 keysym 的键码，用于临时映射中文等字符。
func (k *keymap) spare() (xproto.Keycode, bool) {
	for i := len(k.syms)/k.perCode - 1; i >= 0; i-- {
		empty := true
		for j := 0; j < k.perCode; j++ {
			if k.syms[i*k.perCode+j] != 0 {
				empty = false
				break
			}
		}
		if empty {
			return xproto.Keycode(int(k.min) + i), true
		}
	}
	return 0, false
}

const (
	symShiftL = 0xffe1
	symReturn = 0xff0d
	symTab    = 0xff09
)

func runeToKeysym(r rune) xproto.Keysym {
	switch r {
	case '\n':
		return symReturn
	case '\t':
		return symTab
	}
	if r >= 0x20 && r <= 0x7e || r >= 0xa0 && r <= 0xff {
		return xproto.Keysym(r) // Latin-1 的 keysym 与码点相同
	}
	return xproto.Keysym(0x01000000 | uint32(r)) // Unicode keysym
}

func tapKey(c *xgb.Conn, root xproto.Window, code xproto.Keycode, shift bool, shiftCode xproto.Keycode) error {
	if shift && shiftCode != 0 {
		if err := fake(c, root, xproto.KeyPress, byte(shiftCode), 0, 0); err != nil {
			return err
		}
	}
	if err := fake(c, root, xproto.KeyPress, byte(code), 0, 0); err != nil {
		return err
	}
	if err := fake(c, root, xproto.KeyRelease, byte(code), 0, 0); err != nil {
		return err
	}
	if shift && shiftCode != 0 {
		return fake(c, root, xproto.KeyRelease, byte(shiftCode), 0, 0)
	}
	return nil
}

// TypeText 输入文字。键盘上没有的字符（如中文）临时映射到空闲键码再按下（与 xdotool 相同的做法）。
func TypeText(s string) error {
	mu.Lock()
	defer mu.Unlock()
	c, root, err := conn()
	if err != nil {
		return err
	}
	km, err := loadKeymap(c)
	if err != nil {
		return err
	}
	shiftCode, _, _ := km.find(symShiftL)
	s = strings.ReplaceAll(s, "\r\n", "\n")
	for _, r := range s {
		sym := runeToKeysym(r)
		if code, shift, ok := km.find(sym); ok {
			if err := tapKey(c, root, code, shift, shiftCode); err != nil {
				return err
			}
			continue
		}
		code, ok := km.spare()
		if !ok {
			return fmt.Errorf("没有空闲键码，无法输入字符 %q", r)
		}
		syms := make([]xproto.Keysym, km.perCode)
		syms[0], syms[1%km.perCode] = sym, sym
		if err := xproto.ChangeKeyboardMappingChecked(c, 1, code, byte(km.perCode), syms).Check(); err != nil {
			return fmt.Errorf("修改键盘映射失败：%v", err)
		}
		time.Sleep(15 * time.Millisecond) // 等待客户端收到 MappingNotify
		err := tapKey(c, root, code, false, 0)
		empty := make([]xproto.Keysym, km.perCode)
		_ = xproto.ChangeKeyboardMappingChecked(c, 1, code, byte(km.perCode), empty).Check()
		time.Sleep(5 * time.Millisecond)
		if err != nil {
			return err
		}
	}
	return nil
}

var namedSym = map[string]xproto.Keysym{
	"ctrl": 0xffe3, "shift": 0xffe1, "alt": 0xffe9, "win": 0xffeb,
	"enter": 0xff0d, "esc": 0xff1b, "tab": 0xff09, "space": 0x20, "backspace": 0xff08,
	"delete": 0xffff, "insert": 0xff63, "home": 0xff50, "end": 0xff57, "pageup": 0xff55, "pagedown": 0xff56,
	"left": 0xff51, "up": 0xff52, "right": 0xff53, "down": 0xff54,
	"printscreen": 0xff61, "capslock": 0xffe5, "menu": 0xff67, "numlock": 0xff7f, "scrolllock": 0xff14, "pause": 0xff13,
}

func keyToSym(k string) (xproto.Keysym, error) {
	if s, ok := namedSym[k]; ok {
		return s, nil
	}
	if len(k) >= 2 && k[0] == 'f' {
		var n int
		if _, e := fmt.Sscanf(k, "f%d", &n); e == nil && n >= 1 && n <= 24 {
			return xproto.Keysym(0xffbe + n - 1), nil
		}
	}
	rs := []rune(k)
	if len(rs) == 1 {
		return runeToKeysym(rs[0]), nil
	}
	return 0, fmt.Errorf("不认识的按键：%s", k)
}

// Combo 按下组合键：依次按下，再反序松开。
func Combo(keys []string) error {
	mu.Lock()
	defer mu.Unlock()
	c, root, err := conn()
	if err != nil {
		return err
	}
	km, err := loadKeymap(c)
	if err != nil {
		return err
	}
	shiftCode, _, _ := km.find(symShiftL)
	var codes []xproto.Keycode
	for _, k := range keys {
		sym, err := keyToSym(k)
		if err != nil {
			return err
		}
		code, shift, ok := km.find(sym)
		if !ok {
			return fmt.Errorf("键盘上找不到按键：%s", k)
		}
		if shift && !isModifier(k) && shiftCode != 0 {
			codes = append(codes, shiftCode)
		}
		codes = append(codes, code)
	}
	for _, code := range codes {
		if err := fake(c, root, xproto.KeyPress, byte(code), 0, 0); err != nil {
			return err
		}
	}
	for i := len(codes) - 1; i >= 0; i-- {
		if err := fake(c, root, xproto.KeyRelease, byte(codes[i]), 0, 0); err != nil {
			return err
		}
	}
	return nil
}
