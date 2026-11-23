// Package uia 读取和操作电脑上的界面元素（按钮、输入框、菜单等）。
// Windows 用系统自带的 UI Automation（Win7 起都有）；Linux（AT-SPI）暂未实现。
package uia

// Params 一次调用的参数。
type Params struct {
	Mode   string // windows：列出窗口；tree：列出元素；act：操作元素
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
