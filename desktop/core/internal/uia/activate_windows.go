//go:build windows

package uia

import (
	"errors"
	"fmt"
	"strings"
	"time"
)

// activate：把已经在运行的程序切到前台。
// 窗口最小化就还原；没有窗口（关到托盘里了，如微信、QQ）就点托盘图标把它打开。
// 这样 Agent 不会因为看不到窗口就重复启动程序（微信 4.x 等重复启动会多开，弹出新的登录窗口）。

var procKeybdEvent = user32.NewProc("keybd_event")

const vkF24 = 0x87

// appWindow 标题或进程名包含 want 的顶层窗口：优先没最小化的，再取面积最大的（主窗口一般比登录框、弹窗大）
func (s *session) appWindow(want string) (com, info) {
	wins := s.topWindows()
	var pick com
	var pi info
	score := func(i info) int64 {
		area := int64(i.r.right-i.r.left) * int64(i.r.bottom-i.r.top)
		if !i.offscreen {
			area += 1 << 40
		}
		return area
	}
	for _, w := range wins {
		i := readInfo(w)
		if i.class == "Shell_TrayWnd" || i.class == "Shell_SecondaryTrayWnd" {
			continue
		}
		match := i.name != "" && has(i.name, want)
		if !match {
			// 进程名要完全相同（如 Weixin、QQ），不然「QQ」会匹配到 QQMusic
			pn := strings.TrimSuffix(strings.ToLower(processName(uint32(w.int32(elemProcessID)))), ".exe")
			match = pn != "" && pn == strings.TrimSuffix(strings.ToLower(want), ".exe")
		}
		if match && (!pick.ok() || score(i) > score(pi)) {
			pick, pi = w, i
		}
	}
	for _, w := range wins {
		if w.p != pick.p {
			w.release()
		}
	}
	return pick, pi
}

// bringToFront 还原并切到前台，返回是否成功切到前台
func bringToFront(hwnd uintptr) bool {
	if r, _, _ := procIsIconic.Call(hwnd); r != 0 {
		procShowWindow.Call(hwnd, swRestore)
		time.Sleep(300 * time.Millisecond)
	}
	// 系统只允许「最近收到输入的程序」切换前台窗口：先模拟按一下没有用途的 F24 键
	procKeybdEvent.Call(vkF24, 0, 0, 0)
	procKeybdEvent.Call(vkF24, 0, 2, 0)
	procSetForegroundWindow.Call(hwnd)
	time.Sleep(200 * time.Millisecond)
	fg, _, _ := procGetForegroundWindow.Call()
	return fg == hwnd
}

// trayButton 在一个元素下面找名称和 want 最接近的按钮
func (s *session) trayButton(root com, want string) (com, int) {
	var best com
	bestRank := 0
	var all []com
	var visit func(e com, depth int)
	visit = func(e com, depth int) {
		for c := s.walker.out1(walkerGetFirstChild, uintptr(e.p)); c.ok(); c = s.walker.out1(walkerGetNextSibling, uintptr(c.p)) {
			all = append(all, c)
			i := readInfo(c)
			if i.ctype == controlButton {
				if r := trayRank(i.name, want); r > bestRank {
					best, bestRank = c, r
				}
			}
			if depth < 6 {
				visit(c, depth+1)
			}
		}
	}
	visit(root, 0)
	for _, c := range all {
		if c.p != best.p {
			c.release()
		}
	}
	return best, bestRank
}

// overflowWindow 托盘「显示隐藏的图标」展开后的面板（Win7 / 10：NotifyIconOverflowWindow；Win11：TopLevelWindowForOverflowXamlIsland）
func (s *session) overflowWindow() com {
	wins := s.topWindows()
	var pick com
	for _, w := range wins {
		c := readInfo(w).class
		if !pick.ok() && (c == "NotifyIconOverflowWindow" || c == "TopLevelWindowForOverflowXamlIsland") {
			pick = w
			continue
		}
		w.release()
	}
	return pick
}

// clickTray 点托盘里名称匹配的图标（找不到完全相同的再展开「^」找）；返回点到的图标名，没找到返回空
func (s *session) clickTray(want string) (string, error) {
	wins := s.topWindows()
	var bar com
	for _, w := range wins {
		if !bar.ok() && readInfo(w).class == "Shell_TrayWnd" {
			bar = w
			continue
		}
		w.release()
	}
	if !bar.ok() {
		return "", errors.New("找不到任务栏")
	}
	defer bar.release()
	s.p.Action = "click"
	b, rank := s.trayButton(bar, want)
	defer func() { b.release() }()
	host := bar
	if rank < 3 {
		// 收在「^」里的图标：展开面板再找，更接近的话用面板里的
		var chevron com
		for _, label := range []string{"通知 V 形", "显示隐藏的图标", "Show hidden icons", "Notification Chevron"} {
			if c, r := s.trayButton(bar, label); r > 0 {
				chevron = c
				break
			}
		}
		if chevron.ok() {
			defer chevron.release()
			if _, err := s.act(chevron, bar); err == nil {
				time.Sleep(500 * time.Millisecond)
				if panel := s.overflowWindow(); panel.ok() {
					defer panel.release()
					if pb, pr := s.trayButton(panel, want); pr > rank {
						b.release()
						b, rank, host = pb, pr, panel
					} else {
						pb.release()
					}
				}
				if host == bar {
					// 面板里没有更合适的：收起面板，不留在桌面上
					_, _ = s.act(chevron, bar)
				}
			}
		}
	}
	if rank < 2 {
		return "", nil
	}
	name := readInfo(b).name
	if _, err := s.act(b, host); err != nil {
		return "", err
	}
	return name, nil
}

func (s *session) activate() (string, error) {
	want := strings.TrimSpace(s.p.Window)
	if want == "" {
		return "", errors.New("name 不能为空：填程序名或窗口标题，如「微信」「QQ」「记事本」")
	}
	if !s.p.Restore {
		return "", errors.New("当前权限不能操作界面：请在手机端改为「标准」以上权限并开启「鼠标键盘」")
	}
	show := func(w com, i info, how string) string {
		hwnd := w.ptr(elemNativeWindowHandle)
		msg := how + "「" + short(i.name, 60) + "」"
		if hwnd != 0 && !bringToFront(hwnd) {
			msg += "，但系统没有允许切到前台（可能被别的窗口挡住），需要时点一下它的任务栏按钮"
		} else {
			msg += "，已在前台"
		}
		i = readInfo(w)
		if c := i.center(); c != "" {
			msg += fmt.Sprintf("，窗口中心 %s", c)
		}
		return msg + "。接着用 ui_tree 读取里面的元素。"
	}

	if w, i := s.appWindow(want); w.ok() {
		defer w.release()
		how := "已切换到窗口"
		if hwnd := w.ptr(elemNativeWindowHandle); hwnd != 0 {
			if r, _, _ := procIsIconic.Call(hwnd); r != 0 {
				how = "已还原最小化的窗口"
			}
		}
		return show(w, i, how), nil
	}

	icon, err := s.clickTray(want)
	if err != nil {
		return "", fmt.Errorf("找到了托盘图标但点击失败：%v", err)
	}
	if icon == "" {
		return "", fmt.Errorf("没有找到「%s」的窗口或托盘图标，程序可能没有运行：可以用 shell_exec 启动它，启动后再用 window_activate 或 ui_tree 操作", want)
	}
	// 等窗口出来
	for t := 0; t < 15; t++ {
		time.Sleep(200 * time.Millisecond)
		if w, i := s.appWindow(want); w.ok() {
			defer w.release()
			return show(w, i, "已点击托盘图标「"+short(icon, 30)+"」，打开了窗口"), nil
		}
	}
	return "已点击托盘图标「" + short(icon, 30) + "」，但 3 秒内没有看到窗口出来：用 ui_tree list_windows 看看，或者 screen_capture 截图确认（有的程序要双击或右键菜单里选「打开」）。", nil
}
