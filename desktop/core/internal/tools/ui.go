package tools

import (
	"context"
	"encoding/json"
	"errors"

	"p2d/core/internal/perm"
	"p2d/core/internal/uia"
)

// ui_tree / ui_act：读取和操作界面元素（控件树）。比截图 + 坐标更准：
// 没有文字的图标也有名称（如「开始」按钮），按名称点击不怕窗口位置变化。

// uiaRun 测试时替换，避免动到真实桌面。
var uiaRun = uia.Run

func registerUI(r *Registry) {
	r.Add(&Tool{
		Name: "ui_tree",
		Description: "读取窗口里的界面元素（按钮、输入框、菜单、列表项等），返回「[类型] 名称 (x, y)」，坐标是元素中心的屏幕坐标，可直接用 input_mouse 点击；输入框附带当前值，复选框附带「已勾选 / 未勾选」，菜单项勾上时附带「已勾选」（没标注就是没勾上，需先展开菜单才读得到），列表项 / 标签页附带「已选中」。" +
			"默认读取当前前台窗口；window 指定窗口标题（包含即可），「任务栏」读取任务栏；list_windows=true 列出所有窗口。" +
			"窗口最小化时：有鼠标键盘权限会先还原再读，没有则不动窗口，只提示已最小化。" +
			"元素多时用 name / type 筛选。部分游戏、远程桌面、自绘界面的程序读不到，此时改用 screen_capture。",
		InputSchema: object(map[string]prop{
			"window":       str("窗口标题（包含即可）；不填为前台窗口；「任务栏」为任务栏"),
			"name":         str("只列出名称包含这段文字的元素"),
			"type":         str("只列出这种类型的元素，如 按钮、编辑、菜单项、列表项、复选框"),
			"list_windows": boolean("列出所有打开的窗口（标题、程序、位置），不读取元素"),
			"max":          intg("最多列出的元素数，默认 150，最大 500"),
		}),
		Category: perm.CatScreen, Kind: perm.Read, Handler: uiTree,
	})
	r.Add(&Tool{
		Name: "ui_act",
		Description: "按名称直接操作窗口里的界面元素，不依赖坐标，窗口被遮挡也可以。action：click 点击（按钮、菜单项、链接、列表项；已展开的菜单再 click 会收起）、" +
			"set_value 填写输入框（value 为内容）、focus 让元素获得焦点、toggle 切换复选框 / 开关、expand / collapse 展开或收起。" +
			"name 用 ui_tree 返回的名称；有多个同名元素时用 type 和 index 区分。不支持的元素会返回坐标，改用 input_mouse。",
		InputSchema: object(map[string]prop{
			"name":   str("元素名称（包含即可）"),
			"action": enum("动作", "click", "set_value", "focus", "toggle", "expand", "collapse"),
			"window": str("窗口标题（包含即可）；不填为前台窗口；「任务栏」为任务栏"),
			"type":   str("元素类型，如 按钮、编辑"),
			"index":  intg("第几个匹配的元素，从 1 开始，默认 1"),
			"value":  str("set_value 时要填写的内容"),
		}, "name", "action"),
		Category: perm.CatInput, Kind: perm.Write, Handler: uiAct,
	})
}

func uiTree(ctx context.Context, raw json.RawMessage) (*Result, error) {
	var a struct {
		Window      string `json:"window"`
		Name        string `json:"name"`
		Type        string `json:"type"`
		ListWindows bool   `json:"list_windows"`
		Max         int    `json:"max"`
	}
	if err := decode(raw, &a); err != nil {
		return nil, err
	}
	p := uia.Params{Mode: "tree", Window: a.Window, Name: a.Name, Type: a.Type, Max: a.Max}
	// 还原窗口会改变用户的桌面：和 ui_act 用同样的权限要求
	p.Restore = allowed(ctx, perm.CatInput, perm.Write)
	if a.ListWindows {
		p.Mode = "windows"
	}
	out, err := uiaRun(ctx, p)
	if err != nil {
		return nil, err
	}
	return &Result{Content: []Content{{Type: "text", Text: out}}}, nil
}

func uiAct(ctx context.Context, raw json.RawMessage) (*Result, error) {
	var a struct {
		Name   string `json:"name"`
		Action string `json:"action"`
		Window string `json:"window"`
		Type   string `json:"type"`
		Index  int    `json:"index"`
		Value  string `json:"value"`
	}
	if err := decode(raw, &a); err != nil {
		return nil, err
	}
	if a.Name == "" {
		return nil, errors.New("name 不能为空，可先用 ui_tree 查看元素名称")
	}
	out, err := uiaRun(ctx, uia.Params{
		Mode: "act", Window: a.Window, Name: a.Name, Type: a.Type, Index: a.Index, Action: a.Action, Value: a.Value,
		Restore: allowed(ctx, perm.CatInput, perm.Write),
	})
	if err != nil {
		return nil, err
	}
	return &Result{Content: []Content{{Type: "text", Text: out}}}, nil
}
