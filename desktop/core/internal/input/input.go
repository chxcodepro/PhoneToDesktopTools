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
