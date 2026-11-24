package tools

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"p2d/core/internal/input"
	"p2d/core/internal/perm"
)

func registerInput(r *Registry) {
	r.Add(&Tool{
		Name: "input_mouse",
		Description: "操作鼠标。x、y 默认是屏幕坐标（像素，多显示器时为虚拟桌面坐标，ui_tree 返回的就是屏幕坐标）；" +
			"按截图点击时传 coords=\"screenshot\"，x、y（以及 to_x、to_y）直接填最近一次 screen_capture 截图上的像素坐标，电脑端自动换算。",
		InputSchema: object(map[string]prop{
			"action": enum("动作", "move", "click", "double_click", "right_click", "middle_click", "down", "up", "scroll", "drag"),
			"coords": enum("坐标类型：screen 屏幕坐标（默认）；screenshot 最近一次截图上的像素坐标", "screen", "screenshot"),
			"x":      intg("目标 x 坐标；scroll 时可省略（在当前位置滚动）"),
			"y":      intg("目标 y 坐标"),
			"to_x":   intg("drag 的终点 x"),
			"to_y":   intg("drag 的终点 y"),
			"dy":     intg("scroll 的格数，正数向上，负数向下"),
		}, "action"),
		Category: perm.CatInput, Kind: perm.Write, Handler: inputMouse,
	})
	r.Add(&Tool{
		Name:        "input_keyboard",
		Description: "操作键盘。action=type 时输入 text（支持中文，不依赖输入法）；action=key 时按组合键 keys，如 ctrl+c、alt+tab、ctrl+shift+esc、enter、f5。",
		InputSchema: object(map[string]prop{
			"action": enum("动作", "type", "key"),
			"text":   str("要输入的文字（type 时必填）"),
			"keys":   str("组合键（key 时必填），用 + 连接"),
		}, "action"),
		Category: perm.CatInput, Kind: perm.Write, Handler: inputKeyboard,
	})
}

func inputMouse(ctx context.Context, raw json.RawMessage) (*Result, error) {
	var a struct {
		Action string `json:"action"`
		X      *int   `json:"x"`
		Y      *int   `json:"y"`
		ToX    *int   `json:"to_x"`
		ToY    *int   `json:"to_y"`
		Dy     int    `json:"dy"`
		Coords string `json:"coords"`
	}
	if err := decode(raw, &a); err != nil {
		return nil, err
	}
	hasXY := a.X != nil && a.Y != nil
	// 截图坐标：按最近一次截图换算成屏幕坐标
	shot := a.Coords == "screenshot" || a.Coords == "image"
	if shot {
		for _, p := range [][2]*int{{a.X, a.Y}, {a.ToX, a.ToY}} {
			if p[0] == nil || p[1] == nil {
				continue
			}
			sx, sy, err := fromShot(*p[0], *p[1])
			if err != nil {
				return nil, err
			}
			*p[0], *p[1] = sx, sy
		}
	}
	moveIfGiven := func() error {
		if !hasXY {
			return nil
		}
		if err := input.Move(*a.X, *a.Y); err != nil {
			return err
		}
		time.Sleep(30 * time.Millisecond)
		return nil
	}
	click := func(b input.Button, times int) error {
		for i := 0; i < times; i++ {
			if err := input.Press(b, true); err != nil {
				return err
			}
			time.Sleep(20 * time.Millisecond)
			if err := input.Press(b, false); err != nil {
				return err
			}
			if i+1 < times {
				time.Sleep(60 * time.Millisecond)
			}
		}
		return nil
	}
	needXY := func() error {
		if !hasXY {
			return fmt.Errorf("%s 需要 x 和 y", a.Action)
		}
		return nil
	}

	var err error
	switch a.Action {
	case "move":
		if err = needXY(); err == nil {
			err = input.Move(*a.X, *a.Y)
		}
	case "click", "double_click", "right_click", "middle_click":
		if err = moveIfGiven(); err != nil {
			break
		}
		switch a.Action {
		case "click":
			err = click(input.Left, 1)
		case "double_click":
			err = click(input.Left, 2)
		case "right_click":
			err = click(input.Right, 1)
		case "middle_click":
			err = click(input.Middle, 1)
		}
	case "down", "up":
		if err = moveIfGiven(); err == nil {
			err = input.Press(input.Left, a.Action == "down")
		}
	case "scroll":
		if a.Dy == 0 {
			return nil, errors.New("scroll 需要非零的 dy")
		}
		if err = moveIfGiven(); err == nil {
			err = input.Scroll(a.Dy)
		}
	case "drag":
		if err = needXY(); err != nil {
			break
		}
		if a.ToX == nil || a.ToY == nil {
			return nil, errors.New("drag 需要 to_x 和 to_y")
		}
		err = drag(*a.X, *a.Y, *a.ToX, *a.ToY)
	default:
		return nil, fmt.Errorf("未知的鼠标动作：%s", a.Action)
	}
	if err != nil {
		return nil, err
	}
	msg := "已执行 " + a.Action
	if hasXY {
		msg += fmt.Sprintf("（屏幕坐标 %d, %d）", *a.X, *a.Y)
	}
	return TextResult(msg), nil
}

// drag 分步移动，让目标程序能识别为拖拽。
func drag(x0, y0, x1, y1 int) error {
	if err := input.Move(x0, y0); err != nil {
		return err
	}
	time.Sleep(50 * time.Millisecond)
	if err := input.Press(input.Left, true); err != nil {
		return err
	}
	const steps = 12
	for i := 1; i <= steps; i++ {
		time.Sleep(15 * time.Millisecond)
		if err := input.Move(x0+(x1-x0)*i/steps, y0+(y1-y0)*i/steps); err != nil {
			_ = input.Press(input.Left, false)
			return err
		}
	}
	time.Sleep(50 * time.Millisecond)
	return input.Press(input.Left, false)
}

func inputKeyboard(ctx context.Context, raw json.RawMessage) (*Result, error) {
	var a struct {
		Action string `json:"action"`
		Text   string `json:"text"`
		Keys   string `json:"keys"`
	}
	if err := decode(raw, &a); err != nil {
		return nil, err
	}
	switch a.Action {
	case "type":
		if a.Text == "" {
			return nil, errors.New("type 需要 text")
		}
		if err := input.TypeText(a.Text); err != nil {
			return nil, err
		}
		return TextResult(fmt.Sprintf("已输入 %d 个字符", len([]rune(a.Text)))), nil
	case "key":
		keys, err := input.ParseCombo(a.Keys)
		if err != nil {
			return nil, err
		}
		if err := input.Combo(keys); err != nil {
			return nil, err
		}
		return TextResult("已按下 " + a.Keys), nil
	default:
		return nil, fmt.Errorf("未知的键盘动作：%s", a.Action)
	}
}
