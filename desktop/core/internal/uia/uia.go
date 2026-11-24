// Package uia 读取和操作电脑上的界面元素（按钮、输入框、菜单等）。
// Windows 用系统自带的 UI Automation（Win7 起都有）；Linux（AT-SPI）暂未实现。
package uia

import (
	"strings"
	"unicode/utf8"
)

// Params 一次调用的参数。
type Params struct {
	Mode   string // windows：列出窗口；tree：列出元素；act：操作元素；activate：把程序切到前台（Window 是程序名或标题）；point：屏幕坐标 (X, Y) 上的元素
	Window string // 窗口标题（包含即可）；空 = 前台窗口；taskbar / 任务栏 = 任务栏
	Name   string // 按名称筛选（包含即可）
	Type   string // 按类型筛选（如 按钮、编辑）
	Index  int    // 第几个匹配（act，从 1 开始）
	Action string // act 的动作：click / set_value / focus / toggle / expand / collapse
	Value  string // set_value 的内容
	Max    int    // 最多列出的元素数
	Depth  int    // 最大遍历深度

	// Restore 允许还原最小化的窗口（会改变用户的桌面，只能在有操作界面的权限时设置）
	Restore bool
	// X、Y point 模式查的屏幕坐标
	X, Y int
	// Launch 允许 activate 在程序没运行时找到并启动它（和执行命令同样的权限要求）
	Launch bool
}

func (p *Params) normalize() {
	if p.Index <= 0 {
		p.Index = 1
	}
	if p.Max <= 0 {
		p.Max = 150
	}
	if p.Max > 500 {
		p.Max = 500
	}
	if p.Depth <= 0 {
		p.Depth = 25
	}
	if p.Action == "" {
		p.Action = "click"
	}
}

// trayRank 托盘图标名和要找的程序名有多接近：3 完全相同；2 开头相同且后面是分隔符（如「QQ: 昵称」「微信 - 3 条新消息」）；
// 1 只是开头相同（如找「QQ」时的「QQ音乐」），不能算同一个程序；0 不相干
func trayRank(name, want string) int {
	n := strings.ToLower(strings.TrimSpace(name))
	w := strings.ToLower(strings.TrimSpace(want))
	if n == "" || w == "" {
		return 0
	}
	if n == w {
		return 3
	}
	if !strings.HasPrefix(n, w) {
		return 0
	}
	next, _ := utf8.DecodeRuneInString(n[len(w):])
	if strings.ContainsRune(" :：-—(（[\n\t", next) {
		return 2
	}
	return 1
}
