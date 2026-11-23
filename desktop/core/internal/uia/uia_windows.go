//go:build windows

package uia

import (
	"context"
	"errors"
	"fmt"
	"runtime"
	"strings"
	"sync"
	"time"
	"unsafe"
)

var dpiOnce sync.Once

// Run 执行一次读取或操作，返回给模型看的文字。
// UI Automation 调用可能被没有响应的程序卡住，所以放在单独的线程里，超时就先返回（那个线程会在程序恢复后自行结束）。
func Run(ctx context.Context, p Params) (string, error) {
	p.normalize()
	dpiOnce.Do(func() {
		// 和截图、键鼠一致使用物理像素坐标
		if procSetProcessDPIAware.Find() == nil {
			procSetProcessDPIAware.Call()
		}
	})
	type result struct {
		text string
		err  error
	}
	done := make(chan result, 1)
	go func() {
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		text, err := runCOM(p)
		done <- result{text, err}
	}()
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	select {
	case r := <-done:
		return r.text, r.err
	case <-ctx.Done():
		return "", errors.New("读取界面元素超时（窗口元素太多或程序没有响应），可以用 name / type 缩小范围")
	}
}

func runCOM(p Params) (string, error) {
	if err := procCoInitializeEx.Find(); err != nil {
		return "", errors.New("系统不支持 COM")
	}
	hr, _, _ := procCoInitializeEx.Call(0, coinitMultithreaded)
	if int32(hr) >= 0 {
		defer procCoUninitialize.Call()
	}
	var auto com
	r, _, _ := procCoCreateInstance.Call(uintptr(unsafe.Pointer(&clsidCUIAutomation)), 0, clsctxInprocServer,
		uintptr(unsafe.Pointer(&iidIUIAutomation)), uintptr(unsafe.Pointer(&auto.p)))
	if int32(r) < 0 || !auto.ok() {
		return "", fmt.Errorf("无法使用 UI Automation（0x%08X）", uint32(r))
	}
	defer auto.release()
	walker := auto.out0(autoGetControlViewWalker)
	if !walker.ok() {
		return "", errors.New("无法使用 UI Automation")
	}
	defer walker.release()
	s := &session{auto: auto, walker: walker, p: p}
	return s.run()
}

type session struct {
	auto, walker com
	p            Params
	out          []string
	count        int
	more         bool
	found        []com // act 时收集到的匹配元素（用完释放）
}

// info 元素的常用属性
type info struct {
	name, typ, class string
	ctype            int32
	enabled, focused bool
	offscreen        bool
	r                rect
}

func readInfo(e com) info {
	return info{
		name:      e.bstr(elemName),
		typ:       e.bstr(elemLocalizedControlType),
		class:     e.bstr(elemClassName),
		ctype:     e.int32(elemControlType),
		enabled:   e.int32(elemIsEnabled) != 0,
		focused:   e.int32(elemHasKeyboardFocus) != 0,
		offscreen: e.int32(elemIsOffscreen) != 0,
		r:         e.rect(elemBoundingRectangle),
	}
}

func (i info) center() string {
	if i.r.right <= i.r.left || i.r.bottom <= i.r.top {
		return ""
	}
	return fmt.Sprintf("(%d, %d)", (i.r.left+i.r.right)/2, (i.r.top+i.r.bottom)/2)
}

func (i info) typeName() string {
	if i.typ != "" {
		return i.typ
	}
	return fmt.Sprint(i.ctype)
}

func short(s string, n int) string {
	s = strings.Join(strings.Fields(s), " ")
	if r := []rune(s); len(r) > n {
		return string(r[:n]) + "…"
	}
	return s
}

func has(text, part string) bool {
	if part == "" {
		return true
	}
	return strings.Contains(strings.ToLower(text), strings.ToLower(part))
}

func (s *session) typeMatch(i info) bool {
	if s.p.Type == "" {
		return true
	}
	if has(i.typ, s.p.Type) {
		return true
	}
	// 也接受英文类型名
	en := map[int32]string{50000: "button", 50002: "checkbox", controlComboBox: "combobox", controlEdit: "edit", 50005: "hyperlink link",
		50006: "image", 50007: "listitem", 50008: "list", 50009: "menu", 50010: "menubar", 50011: "menuitem", 50013: "radiobutton",
		50018: "tab", 50019: "tabitem", 50020: "text", 50024: "treeitem", controlDocument: "document", 50032: "window", 50033: "pane"}
	return has(en[i.ctype], s.p.Type)
}

func (s *session) describe(e com, i info) string {
	line := "[" + i.typeName() + "] " + short(i.name, 60)
	if c := i.center(); c != "" {
		line += " " + c
	}
	if !i.enabled {
		line += " 不可用"
	}
	if i.focused {
		line += " 当前焦点"
	}
	if i.ctype == controlEdit || i.ctype == controlComboBox {
		if vp := e.pattern(patternValue, &iidValuePattern); vp.ok() {
			v := vp.bstr(valueCurrentValue)
			vp.release()
			line += ` 值="` + short(v, 40) + `"`
		}
	}
	// 勾选 / 选中 / 展开状态（只查可能有这些状态的类型，减少调用）
	switch i.ctype {
	case controlCheckBox, controlMenuItem, controlButton, controlRadioButton, controlListItem, controlTreeItem, controlTabItem:
		if tp := e.pattern(patternToggle, &iidTogglePattern); tp.ok() {
			line += " " + map[int32]string{0: "未勾选", 1: "已勾选", 2: "部分勾选"}[tp.int32(toggleState)]
			tp.release()
		} else if lp := e.pattern(patternLegacy, &iidLegacyPattern); lp.ok() {
			// 经典 Win32 菜单项的勾选状态在 MSAA 状态位里（分不清「没勾选」和「不能勾选」，只标注勾上的）
			if lp.int32(legacyState)&msaaChecked != 0 {
				line += " 已勾选"
			}
			lp.release()
		}
		if sp := e.pattern(patternSelectionItem, &iidSelectionPattern); sp.ok() {
			if sp.int32(selectionIsSelected) != 0 {
				line += " 已选中"
			}
			sp.release()
		}
		if i.ctype == controlMenuItem || i.ctype == controlTreeItem {
			if ep := e.pattern(patternExpand, &iidExpandPattern); ep.ok() {
				if ep.int32(expandState) == expandStateExpanded {
					line += " 已展开"
				}
				ep.release()
			}
		}
	}
	return line
}

// topWindows 桌面下的顶层窗口（调用方负责释放）
func (s *session) topWindows() []com {
	root := s.auto.out0(autoGetRootElement)
	if !root.ok() {
		return nil
	}
	defer root.release()
	var list []com
	for k := s.walker.out1(walkerGetFirstChild, uintptr(root.p)); k.ok(); k = s.walker.out1(walkerGetNextSibling, uintptr(k.p)) {
		list = append(list, k)
	}
	return list
}

func releaseAll(list []com) {
	for _, e := range list {
		e.release()
	}
}

// findWindow 找目标窗口：前台窗口 / 任务栏 / 标题包含的窗口
func (s *session) findWindow() com {
	if s.p.Window == "" {
		hwnd, _, _ := procGetForegroundWindow.Call()
		if hwnd == 0 {
			return com{}
		}
		return s.auto.out1(autoElementFromHandle, hwnd)
	}
	wins := s.topWindows()
	var pick com
	taskbar := s.p.Window == "taskbar" || s.p.Window == "任务栏"
	for pass := 0; pass < 2 && !pick.ok(); pass++ {
		for _, w := range wins {
			i := readInfo(w)
			match := (taskbar && i.class == "Shell_TrayWnd") || (!taskbar && i.name != "" && has(i.name, s.p.Window))
			// 先找没最小化的，再放宽
			if match && (pass == 1 || !i.offscreen) {
				pick = w
				break
			}
		}
	}
	for _, w := range wins {
		if w.p != pick.p {
			w.release()
		}
	}
	return pick
}

// walk 遍历子元素。tree 且没有筛选时按层级缩进列出有名称的元素；否则只收集 / 列出匹配的。
func (s *session) walk(e com, depth, indent int) {
	for c := s.walker.out1(walkerGetFirstChild, uintptr(e.p)); c.ok(); {
		if s.count >= s.p.Max {
			s.more = true
			c.release()
			return
		}
		i := readInfo(c)
		keep := false
		if !i.offscreen {
			next := indent
			if s.p.Mode == "tree" && s.p.Name == "" && s.p.Type == "" {
				if i.name != "" || i.ctype == controlEdit {
					s.out = append(s.out, strings.Repeat("  ", indent)+s.describe(c, i))
					s.count++
					next = indent + 1
				}
			} else if i.name != "" && has(i.name, s.p.Name) && s.typeMatch(i) {
				if s.p.Mode == "tree" {
					s.out = append(s.out, s.describe(c, i))
				} else {
					s.found = append(s.found, c)
					keep = true
				}
				s.count++
			}
			if depth < s.p.Depth {
				s.walk(c, depth+1, next)
			}
		}
		n := s.walker.out1(walkerGetNextSibling, uintptr(c.p))
		if !keep {
			c.release()
		}
		c = n
	}
}

func (s *session) run() (string, error) {
	if s.p.Mode == "windows" {
		wins := s.topWindows()
		defer releaseAll(wins)
		for _, w := range wins {
			i := readInfo(w)
			if i.name == "" {
				continue
			}
			line := "[" + i.typeName() + "] " + short(i.name, 80)
			if pn := processName(uint32(w.int32(elemProcessID))); pn != "" {
				line += " — " + pn
			}
			if i.offscreen {
				line += " 已最小化"
			} else if c := i.center(); c != "" {
				line += " " + c
			}
			s.out = append(s.out, line)
		}
		return strings.Join(s.out, "\n"), nil
	}

	w := s.findWindow()
	if !w.ok() {
		if s.p.Window == "" {
			return "", errors.New("找不到前台窗口")
		}
		return "", fmt.Errorf("找不到标题包含「%s」的窗口，可以先用 list_windows 列出所有窗口", s.p.Window)
	}
	defer w.release()
	wi := readInfo(w)
	// 最小化的窗口里的元素都在屏幕外，读不到也点不了：允许时先还原，否则如实说明、不动窗口
	restored := false
	if hwnd := w.ptr(elemNativeWindowHandle); hwnd != 0 {
		if r, _, _ := procIsIconic.Call(hwnd); r != 0 {
			if !s.p.Restore {
				return "窗口「" + short(wi.name, 80) + "」已最小化，读不到里面的元素。当前权限不能操作界面，所以没有还原它：" +
					"请让用户先在电脑上打开这个窗口，或在手机端改为「标准」以上权限并开启「鼠标键盘」。", nil
			}
			procShowWindow.Call(hwnd, swRestore)
			time.Sleep(400 * time.Millisecond)
			wi = readInfo(w)
			restored = true
		}
	}

	if s.p.Mode == "tree" {
		head := "窗口：" + short(wi.name, 80) + " " + wi.center()
		if restored {
			head += "（原来是最小化的，已还原）"
		}
		s.out = append(s.out, head)
		s.walk(w, 0, 0)
		switch {
		case s.count == 0 && (s.p.Name != "" || s.p.Type != ""):
			s.out = append(s.out, "没有找到匹配的元素")
		case s.count == 0:
			s.out = append(s.out, "这个窗口没有提供可读取的界面元素（部分游戏、远程桌面、自绘界面的程序不支持），请改用 screen_capture")
		}
		if s.more {
			s.out = append(s.out, fmt.Sprintf("……元素较多，只列出前 %d 个。可以用 name / type 筛选，或增大 max", s.p.Max))
		}
		return strings.Join(s.out, "\n"), nil
	}

	// act：多收集一些同名元素，优先在「支持这个动作」的元素里取第 Index 个
	// （如展开的菜单面板和菜单栏上的菜单项同名时，点击应该落在菜单项上）
	s.p.Max = s.p.Index + 20
	s.walk(w, 0, 0)
	defer releaseAll(s.found)
	var capable []com
	for _, e := range s.found {
		if s.supports(e) {
			capable = append(capable, e)
		}
	}
	if len(capable) >= s.p.Index {
		return s.act(capable[s.p.Index-1], w)
	}
	if len(s.found) < s.p.Index {
		return "", fmt.Errorf("在窗口「%s」里没有找到第 %d 个名称包含「%s」的元素，可以先用 ui_tree 查看", short(wi.name, 40), s.p.Index, s.p.Name)
	}
	return s.act(s.found[s.p.Index-1], w)
}

// supports 元素是否支持当前动作需要的模式
func (s *session) supports(e com) bool {
	check := func(id int, iid *guid) bool {
		p := e.pattern(id, iid)
		defer p.release()
		return p.ok()
	}
	switch s.p.Action {
	case "click":
		return check(patternInvoke, &iidInvokePattern) || check(patternSelectionItem, &iidSelectionPattern) ||
			check(patternToggle, &iidTogglePattern) || check(patternExpand, &iidExpandPattern)
	case "set_value":
		return check(patternValue, &iidValuePattern)
	case "toggle":
		return check(patternToggle, &iidTogglePattern)
	case "expand", "collapse":
		return check(patternExpand, &iidExpandPattern)
	}
	return true
}

func (s *session) act(e, win com) (string, error) {
	i := readInfo(e)
	label := "「" + short(i.name, 40) + "」"
	if !i.enabled {
		return "", errors.New(label + " 当前不可用（灰色）")
	}
	try := func(id int, iid *guid, method int, done string) (bool, string) {
		pat := e.pattern(id, iid)
		if !pat.ok() {
			return false, ""
		}
		defer pat.release()
		if hr := pat.call0(method); hr < 0 {
			return true, ""
		}
		return true, done + label
	}
	switch s.p.Action {
	case "click":
		// 已展开的菜单 / 下拉框：像鼠标一样，再点一次就收起（否则 Invoke / Expand 会让它保持展开）
		if ep := e.pattern(patternExpand, &iidExpandPattern); ep.ok() {
			expanded := ep.int32(expandState) == expandStateExpanded
			if expanded && ep.call0(expandCollapse) >= 0 {
				ep.release()
				return "已收起" + label, nil
			}
			ep.release()
		}
		for _, t := range []struct {
			id     int
			iid    *guid
			method int
			done   string
		}{
			{patternInvoke, &iidInvokePattern, invokeInvoke, "已点击"},
			{patternSelectionItem, &iidSelectionPattern, selectionSelect, "已选中"},
			{patternToggle, &iidTogglePattern, toggleToggle, "已切换"},
			{patternExpand, &iidExpandPattern, expandExpand, "已展开"},
			{patternLegacy, &iidLegacyPattern, legacyDoDefaultAction, "已点击"},
		} {
			if supported, msg := try(t.id, t.iid, t.method, t.done); supported {
				if msg == "" {
					return "", errors.New(label + " 操作失败，请改用 input_mouse 点击 " + i.center())
				}
				return msg, nil
			}
		}
		return "", errors.New(label + " 不支持直接点击，请用 input_mouse 点击它的坐标 " + i.center())
	case "set_value":
		vp := e.pattern(patternValue, &iidValuePattern)
		if !vp.ok() {
			return "", errors.New(label + " 不能直接填写，请先 focus 再用 input_keyboard 输入")
		}
		defer vp.release()
		if vp.int32(valueIsReadOnly) != 0 {
			return "", errors.New(label + " 是只读的")
		}
		b := allocBSTR(s.p.Value)
		defer procSysFreeString.Call(b)
		if hr := vp.call1(valueSetValue, b); hr < 0 {
			return "", fmt.Errorf("%s 填写失败（0x%08X），请先 focus 再用 input_keyboard 输入", label, uint32(hr))
		}
		return "已填写" + label, nil
	case "focus":
		if hwnd := win.ptr(elemNativeWindowHandle); hwnd != 0 {
			procSetForegroundWindow.Call(hwnd)
		}
		if hr := e.call0(elemSetFocus); hr < 0 {
			return "", fmt.Errorf("%s 无法获得焦点（0x%08X）", label, uint32(hr))
		}
		return "已聚焦" + label, nil
	case "toggle":
		tp := e.pattern(patternToggle, &iidTogglePattern)
		if !tp.ok() {
			return "", errors.New(label + " 不是开关 / 复选框")
		}
		defer tp.release()
		tp.call0(toggleToggle)
		state := map[int32]string{0: "未选中", 1: "已选中", 2: "部分选中"}[tp.int32(toggleState)]
		return "已切换" + label + "，现在：" + state, nil
	case "expand", "collapse":
		ep := e.pattern(patternExpand, &iidExpandPattern)
		if !ep.ok() {
			return "", errors.New(label + " 不能展开或收起")
		}
		defer ep.release()
		if s.p.Action == "expand" {
			ep.call0(expandExpand)
			return "已展开" + label, nil
		}
		ep.call0(expandCollapse)
		return "已收起" + label, nil
	}
	return "", fmt.Errorf("不支持的动作：%s", s.p.Action)
}
