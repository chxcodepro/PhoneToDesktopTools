//go:build windows

package input

import (
	"fmt"
	"strings"
	"syscall"
	"time"
	"unicode/utf16"
	"unsafe"
)

var (
	user32           = syscall.NewLazyDLL("user32.dll")
	procSendInput    = user32.NewProc("SendInput")
	procSetCursorPos = user32.NewProc("SetCursorPos")
	procVkKeyScanW   = user32.NewProc("VkKeyScanW")
)

const (
	inputMouse    = 0
	inputKeyboard = 1

	mouseLeftDown   = 0x0002
	mouseLeftUp     = 0x0004
	mouseRightDown  = 0x0008
	mouseRightUp    = 0x0010
	mouseMiddleDown = 0x0020
	mouseMiddleUp   = 0x0040
	mouseWheel      = 0x0800

	keyExtended = 0x0001
	keyUp       = 0x0002
	keyUnicode  = 0x0004
)

// 与 C 的 INPUT 结构体布局一致：amd64 下 40 字节，386 下 28 字节。
type mouseInputT struct {
	Dx          int32
	Dy          int32
	MouseData   uint32
	DwFlags     uint32
	Time        uint32
	DwExtraInfo uintptr
}

type mouseINPUT struct {
	Type uint32
	Mi   mouseInputT
}

type keybdInputT struct {
	WVk         uint16
	WScan       uint16
	DwFlags     uint32
	Time        uint32
	DwExtraInfo uintptr
}

type keybdINPUT struct {
	Type uint32
	Ki   keybdInputT
	_    [8]byte
}

func init() {
	if unsafe.Sizeof(mouseINPUT{}) != unsafe.Sizeof(keybdINPUT{}) {
		panic("INPUT 结构体大小不一致")
	}
}

func sendMouse(flags, data uint32) error {
	in := mouseINPUT{Type: inputMouse, Mi: mouseInputT{DwFlags: flags, MouseData: data}}
	n, _, err := procSendInput.Call(1, uintptr(unsafe.Pointer(&in)), unsafe.Sizeof(in))
	if n != 1 {
		return fmt.Errorf("SendInput 失败（可能目标窗口以管理员身份运行）：%v", err)
	}
	return nil
}

func sendKeys(ins []keybdINPUT) error {
	if len(ins) == 0 {
		return nil
	}
	n, _, err := procSendInput.Call(uintptr(len(ins)), uintptr(unsafe.Pointer(&ins[0])), unsafe.Sizeof(ins[0]))
	if int(n) != len(ins) {
		return fmt.Errorf("SendInput 失败（可能目标窗口以管理员身份运行）：%v", err)
	}
	return nil
}

// secure 锁屏时交给锁屏助手（以 SYSTEM 身份运行，能操作锁屏界面和 UAC 确认窗口）
func secure(op Op) (bool, error) {
	if Secure == nil {
		return false, nil
	}
	return Secure(op)
}

// Move 把鼠标移到虚拟桌面坐标 (x, y)。
func Move(x, y int) error {
	if ok, err := secure(Op{Kind: "move", X: x, Y: y}); ok {
		return err
	}
	r, _, err := procSetCursorPos.Call(uintptr(int32(x)), uintptr(int32(y)))
	if r == 0 {
		return fmt.Errorf("SetCursorPos 失败：%v", err)
	}
	return nil
}

// Press 按下或松开鼠标键。
func Press(b Button, down bool) error {
	if ok, err := secure(Op{Kind: "press", Button: b, Down: down}); ok {
		return err
	}
	var f uint32
	switch b {
	case Left:
		f = mouseLeftUp
		if down {
			f = mouseLeftDown
		}
	case Right:
		f = mouseRightUp
		if down {
			f = mouseRightDown
		}
	case Middle:
		f = mouseMiddleUp
		if down {
			f = mouseMiddleDown
		}
	}
	return sendMouse(f, 0)
}

// Scroll 滚轮，dy 为正向上。
func Scroll(dy int) error {
	if ok, err := secure(Op{Kind: "scroll", DY: dy}); ok {
		return err
	}
	return sendMouse(mouseWheel, uint32(int32(dy*120)))
}

// TypeText 输入任意 Unicode 文字（含中文，不依赖输入法）。
func TypeText(s string) error {
	if ok, err := secure(Op{Kind: "text", Text: s}); ok {
		return err
	}
	s = strings.ReplaceAll(s, "\r\n", "\n")
	var batch []keybdINPUT
	flush := func() error {
		err := sendKeys(batch)
		batch = batch[:0]
		time.Sleep(5 * time.Millisecond)
		return err
	}
	for _, r := range s {
		switch r {
		case '\n':
			batch = append(batch, vkDown(0x0D), vkUp(0x0D))
			continue
		case '\t':
			batch = append(batch, vkDown(0x09), vkUp(0x09))
			continue
		}
		for _, u := range utf16.Encode([]rune{r}) {
			batch = append(batch,
				keybdINPUT{Type: inputKeyboard, Ki: keybdInputT{WScan: u, DwFlags: keyUnicode}},
				keybdINPUT{Type: inputKeyboard, Ki: keybdInputT{WScan: u, DwFlags: keyUnicode | keyUp}})
		}
		if len(batch) >= 64 {
			if err := flush(); err != nil {
				return err
			}
		}
	}
	return flush()
}

var namedVK = map[string]uint16{
	"ctrl": 0x11, "shift": 0x10, "alt": 0x12, "win": 0x5B,
	"enter": 0x0D, "esc": 0x1B, "tab": 0x09, "space": 0x20, "backspace": 0x08,
	"delete": 0x2E, "insert": 0x2D, "home": 0x24, "end": 0x23, "pageup": 0x21, "pagedown": 0x22,
	"left": 0x25, "up": 0x26, "right": 0x27, "down": 0x28,
	"printscreen": 0x2C, "capslock": 0x14, "menu": 0x5D, "numlock": 0x90, "scrolllock": 0x91, "pause": 0x13,
}

// 需要 EXTENDEDKEY 标志的键
var extendedVK = map[uint16]bool{0x2E: true, 0x2D: true, 0x24: true, 0x23: true, 0x21: true, 0x22: true,
	0x25: true, 0x26: true, 0x27: true, 0x28: true, 0x5B: true, 0x5D: true, 0x2C: true}

func vkDown(vk uint16) keybdINPUT {
	f := uint32(0)
	if extendedVK[vk] {
		f |= keyExtended
	}
	return keybdINPUT{Type: inputKeyboard, Ki: keybdInputT{WVk: vk, DwFlags: f}}
}

func vkUp(vk uint16) keybdINPUT {
	in := vkDown(vk)
	in.Ki.DwFlags |= keyUp
	return in
}

func keyToVK(k string) (vk uint16, needShift bool, err error) {
	if v, ok := namedVK[k]; ok {
		return v, false, nil
	}
	if len(k) >= 2 && k[0] == 'f' {
		var n int
		if _, e := fmt.Sscanf(k, "f%d", &n); e == nil && n >= 1 && n <= 24 {
			return uint16(0x70 + n - 1), false, nil
		}
	}
	rs := []rune(k)
	if len(rs) == 1 {
		r := rs[0]
		if r >= 'a' && r <= 'z' {
			return uint16('A' + (r - 'a')), false, nil
		}
		if r >= '0' && r <= '9' {
			return uint16(r), false, nil
		}
		res, _, _ := procVkKeyScanW.Call(uintptr(r))
		if int16(res) != -1 {
			return uint16(res & 0xFF), res&0x100 != 0, nil
		}
	}
	return 0, false, fmt.Errorf("不认识的按键：%s", k)
}

// Combo 按下组合键，如 ["ctrl","c"]：依次按下，再反序松开。
func Combo(keys []string) error {
	if ok, err := secure(Op{Kind: "combo", Keys: keys}); ok {
		return err
	}
	var vks []uint16
	shiftAdded := false
	for _, k := range keys {
		vk, needShift, err := keyToVK(k)
		if err != nil {
			return err
		}
		if needShift && !shiftAdded {
			vks = append([]uint16{0x10}, vks...)
			shiftAdded = true
		}
		vks = append(vks, vk)
	}
	var ins []keybdINPUT
	for _, vk := range vks {
		ins = append(ins, vkDown(vk))
	}
	for i := len(vks) - 1; i >= 0; i-- {
		ins = append(ins, vkUp(vks[i]))
	}
	return sendKeys(ins)
}

// TypeASCII 用普通按键（虚拟键码，按当前键盘布局）输入英文、数字和符号。
// 锁屏界面的密码框不一定认 Unicode 方式（VK_PACKET）输入的字，锁屏助手输入纯英文时用这个
func TypeASCII(s string) error {
	var ins []keybdINPUT
	for _, r := range s {
		switch {
		case r == '\n' || r == '\r':
			ins = append(ins, vkDown(0x0D), vkUp(0x0D))
			continue
		case r == '\t':
			ins = append(ins, vkDown(0x09), vkUp(0x09))
			continue
		case r < 0x20 || r > 0x7E:
			return TypeText(string(r))
		}
		res, _, _ := procVkKeyScanW.Call(uintptr(r))
		if int16(res) == -1 {
			ins = append(ins,
				keybdINPUT{Type: inputKeyboard, Ki: keybdInputT{WScan: uint16(r), DwFlags: keyUnicode}},
				keybdINPUT{Type: inputKeyboard, Ki: keybdInputT{WScan: uint16(r), DwFlags: keyUnicode | keyUp}})
			continue
		}
		vk, shift := uint16(res&0xFF), res&0x100 != 0
		if shift {
			ins = append(ins, vkDown(0x10))
		}
		ins = append(ins, vkDown(vk), vkUp(vk))
		if shift {
			ins = append(ins, vkUp(0x10))
		}
	}
	for len(ins) > 0 {
		n := len(ins)
		if n > 64 {
			n = 64
		}
		if err := sendKeys(ins[:n]); err != nil {
			return err
		}
		ins = ins[n:]
		time.Sleep(5 * time.Millisecond)
	}
	return nil
}
