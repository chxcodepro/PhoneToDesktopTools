//go:build windows

package uia

import (
	"errors"
	"syscall"
	"unsafe"
)

const autoElementFromPoint = 7 // IUIAutomation::ElementFromPoint

// point：屏幕坐标 (X, Y) 上是什么界面元素，如「按钮「发送」，在窗口「微信」里」。
// input_mouse 点击前调用，让模型马上知道这一下点到了什么，点偏了能及时改，不用每次都截图确认。
func (s *session) point() (string, error) {
	var e com
	var hr int32
	if ptrSize == 8 {
		// POINT 按值传递：64 位系统放在一个寄存器里（低 32 位 x，高 32 位 y）
		pt := uintptr(uint32(int32(s.p.X))) | uintptr(uint32(int32(s.p.Y)))<<32
		hr = s.auto.call2(autoElementFromPoint, pt, uintptr(unsafe.Pointer(&e.p)))
	} else {
		// 32 位系统：x、y 各占一个参数
		r, _, _ := syscall.SyscallN(s.auto.fn(autoElementFromPoint), uintptr(s.auto.p), uintptr(uint32(int32(s.p.X))), uintptr(uint32(int32(s.p.Y))), uintptr(unsafe.Pointer(&e.p)))
		hr = int32(r)
	}
	if hr < 0 || !e.ok() {
		return "", errors.New("读不到这个位置的界面元素")
	}
	// 往上找：没有名称的元素（如按钮里的图标、文字）换成最近的有名称的上级；最上面一层（桌面）之下是顶层窗口
	chain := []com{e}
	for c := e; ; {
		p := s.walker.out1(walkerGetParent, uintptr(c.p))
		if !p.ok() || len(chain) > 40 {
			break
		}
		chain = append(chain, p)
		c = p
	}
	defer releaseAll(chain)

	target := readInfo(chain[0])
	for i := 1; target.name == "" && i < len(chain)-1 && i <= 3; i++ {
		if pi := readInfo(chain[i]); pi.name != "" {
			target = pi
		}
	}
	out := ""
	if target.name != "" {
		out = target.typeName() + "「" + short(target.name, 40) + "」"
	} else {
		out = "没有名称的" + target.typeName()
	}
	// chain 最后一个是桌面，倒数第二个是顶层窗口
	if len(chain) >= 3 {
		if ti := readInfo(chain[len(chain)-2]); ti.name != "" && ti.name != target.name {
			out += "，在窗口「" + short(ti.name, 30) + "」里"
		}
	}
	return out, nil
}
