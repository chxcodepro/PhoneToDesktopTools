// Package input 模拟鼠标和键盘。Windows 用 SendInput，Linux 用 X11 XTest 扩展，Mac 用 CoreGraphics 事件。
package input

import (
	"fmt"
	"strings"
)

// Button 鼠标按键。
type Button int

const (
	Left Button = iota
	Right
	Middle
)

// Op 一次键鼠操作（锁屏时转给锁屏助手做，见 Secure）。
type Op struct {
	Kind   string   `json:"kind"` // move、press、scroll、text、combo
	X      int      `json:"x,omitempty"`
	Y      int      `json:"y,omitempty"`
	Button Button   `json:"button,omitempty"`
	Down   bool     `json:"down,omitempty"`
	DY     int      `json:"dy,omitempty"`
	Text   string   `json:"text,omitempty"`
	Keys   []string `json:"keys,omitempty"`
}

// Secure 锁屏时代为操作的锁屏助手（Windows，见 secdesk）：handled 为 false 时照常自己发。没装时为 nil
var Secure func(op Op) (handled bool, err error)

// Do 执行一次操作（锁屏助手收到请求后调用）。
func Do(op Op) error {
	switch op.Kind {
	case "move":
		return Move(op.X, op.Y)
	case "press":
		return Press(op.Button, op.Down)
	case "scroll":
		return Scroll(op.DY)
	case "text":
		return TypeText(op.Text)
	case "combo":
		return Combo(op.Keys)
	}
	return fmt.Errorf("不认识的操作：%s", op.Kind)
}

// ParseCombo 解析 "ctrl+shift+s" 这样的组合键，返回小写的键名列表。
func ParseCombo(s string) ([]string, error) {
	s = strings.ToLower(strings.TrimSpace(s))
	if s == "" {
		return nil, fmt.Errorf("keys 不能为空")
	}
	// 允许 "ctrl++" 表示 ctrl 加 + 号
	var keys []string
	parts := strings.Split(s, "+")
	for i := 0; i < len(parts); i++ {
		p := strings.TrimSpace(parts[i])
		if p == "" {
			if i+1 < len(parts) && strings.TrimSpace(parts[i+1]) == "" {
				keys = append(keys, "+")
				i++
				continue
			}
			continue
		}
		keys = append(keys, normalizeKey(p))
	}
	if len(keys) == 0 {
		return nil, fmt.Errorf("无法解析组合键：%s", s)
	}
	return keys, nil
}

func normalizeKey(k string) string {
	switch k {
	case "control", "ctl":
		return "ctrl"
	case "option", "menu_alt":
		return "alt"
	case "cmd", "command", "meta", "super", "windows", "start":
		return "win"
	case "return":
		return "enter"
	case "escape":
		return "esc"
	case "del":
		return "delete"
	case "ins":
		return "insert"
	case "pgup", "page_up":
		return "pageup"
	case "pgdn", "page_down":
		return "pagedown"
	case "back", "bksp":
		return "backspace"
	case "arrowup":
		return "up"
	case "arrowdown":
		return "down"
	case "arrowleft":
		return "left"
	case "arrowright":
		return "right"
	case "prtsc", "print":
		return "printscreen"
	case "caps":
		return "capslock"
	case "apps", "contextmenu":
		return "menu"
	case "spacebar":
		return "space"
	}
	return k
}

func isModifier(k string) bool {
	return k == "ctrl" || k == "shift" || k == "alt" || k == "win"
}
