//go:build windows

package uia

// 直接调用系统的 UI Automation COM 接口（UIAutomationCore.dll，Win7 起都有）。
// 接口方法序号对照 Wine 的 uiautomationclient.idl（mingw-w64 的 uiautomationclient.h 由它生成）。

import (
	"syscall"
	"unsafe"
)

var (
	ole32    = syscall.NewLazyDLL("ole32.dll")
	oleaut32 = syscall.NewLazyDLL("oleaut32.dll")
	user32   = syscall.NewLazyDLL("user32.dll")
	kernel32 = syscall.NewLazyDLL("kernel32.dll")

	procCoInitializeEx             = ole32.NewProc("CoInitializeEx")
	procCoUninitialize             = ole32.NewProc("CoUninitialize")
	procCoCreateInstance           = ole32.NewProc("CoCreateInstance")
	procSysAllocString             = oleaut32.NewProc("SysAllocString")
	procSysFreeString              = oleaut32.NewProc("SysFreeString")
	procSysStringLen               = oleaut32.NewProc("SysStringLen")
	procGetForegroundWindow        = user32.NewProc("GetForegroundWindow")
	procSetForegroundWindow        = user32.NewProc("SetForegroundWindow")
	procSetProcessDPIAware         = user32.NewProc("SetProcessDPIAware")
	procIsIconic                   = user32.NewProc("IsIconic")
	procShowWindow                 = user32.NewProc("ShowWindow")
	procOpenProcess                = kernel32.NewProc("OpenProcess")
	procQueryFullProcessImageNameW = kernel32.NewProc("QueryFullProcessImageNameW")
	procCloseHandle                = kernel32.NewProc("CloseHandle")
)

type guid struct {
	d1     uint32
	d2, d3 uint16
	d4     [8]byte
}

var (
	clsidCUIAutomation  = guid{0xff48dba4, 0x60ef, 0x4201, [8]byte{0xaa, 0x87, 0x54, 0x10, 0x3e, 0xef, 0x59, 0x4e}}
	iidIUIAutomation    = guid{0x30cbe57d, 0xd9d0, 0x452a, [8]byte{0xab, 0x13, 0x7a, 0xc5, 0xac, 0x48, 0x25, 0xee}}
	iidInvokePattern    = guid{0xfb377fbe, 0x8ea6, 0x46d5, [8]byte{0x9c, 0x73, 0x64, 0x99, 0x64, 0x2d, 0x30, 0x59}}
	iidValuePattern     = guid{0xa94cd8b1, 0x0844, 0x4cd6, [8]byte{0x9d, 0x2d, 0x64, 0x05, 0x37, 0xab, 0x39, 0xe9}}
	iidTogglePattern    = guid{0x94cf8058, 0x9b8d, 0x4ab9, [8]byte{0x8b, 0xfd, 0x4c, 0xd0, 0xa3, 0x3c, 0x8c, 0x70}}
	iidExpandPattern    = guid{0x619be086, 0x1f4e, 0x4ee4, [8]byte{0xba, 0xfa, 0x21, 0x01, 0x28, 0x73, 0x87, 0x30}}
	iidSelectionPattern = guid{0xa8efa66a, 0x0fda, 0x421a, [8]byte{0x91, 0x94, 0x38, 0x02, 0x1f, 0x35, 0x78, 0xea}}
	iidLegacyPattern    = guid{0x828055ad, 0x355b, 0x4435, [8]byte{0x86, 0xd5, 0x3b, 0x51, 0xc1, 0x4a, 0x9b, 0x1b}}
)

// 模式（Pattern）和控件类型的编号
const (
	patternInvoke        = 10000
	patternValue         = 10002
	patternExpand        = 10005
	patternSelectionItem = 10010
	patternToggle        = 10015
	patternLegacy        = 10018

	swRestore = 9

	// ExpandCollapseState
	expandStateExpanded = 1

	// MSAA 状态位
	msaaChecked = 0x10

	controlButton      = 50000
	controlCheckBox    = 50002
	controlComboBox    = 50003
	controlEdit        = 50004
	controlListItem    = 50007
	controlMenuItem    = 50011
	controlRadioButton = 50013
	controlTabItem     = 50019
	controlTreeItem    = 50024
	controlDocument    = 50030
)

// IUIAutomation 方法序号
const (
	autoGetRootElement       = 5
	autoElementFromHandle    = 6
	autoGetControlViewWalker = 14
)

// IUIAutomationTreeWalker 方法序号
const (
	walkerGetParent      = 3
	walkerGetFirstChild  = 4
	walkerGetNextSibling = 6
)

// IUIAutomationElement 方法序号
const (
	elemSetFocus             = 3
	elemGetCurrentPattern    = 16
	elemProcessID            = 20
	elemControlType          = 21
	elemLocalizedControlType = 22
	elemName                 = 23
	elemHasKeyboardFocus     = 26
	elemIsEnabled            = 28
	elemClassName            = 30
	elemNativeWindowHandle   = 36
	elemIsOffscreen          = 38
	elemBoundingRectangle    = 43
	valueSetValue            = 3
	valueCurrentValue        = 4
	valueIsReadOnly          = 5
	toggleToggle             = 3
	toggleState              = 4
	expandState              = 5
	selectionIsSelected      = 6
	legacyDoDefaultAction    = 4
	legacyState              = 11
	expandExpand             = 3
	expandCollapse           = 4
	selectionSelect          = 3
	invokeInvoke             = 3
	unknownQueryInterface    = 0
	unknownRelease           = 2
	coinitMultithreaded      = 0x0
	clsctxInprocServer       = 0x1
	processQueryLimitedInfo  = 0x1000
	ptrSize                  = unsafe.Sizeof(uintptr(0))
)

// com 一个 COM 对象指针（不是 Go 内存）。
type com struct{ p unsafe.Pointer }

func (o com) ok() bool { return o.p != nil }

// fn 第 i 个虚函数的地址
func (o com) fn(i int) uintptr {
	vtbl := *(*unsafe.Pointer)(o.p)
	return *(*uintptr)(unsafe.Add(vtbl, uintptr(i)*ptrSize))
}

// call0 / call1 / call2 调用第 i 个虚函数，返回 HRESULT。
// 输出参数（指向 Go 变量的指针）必须直接在调用处写成 uintptr(unsafe.Pointer(&x))：
// 有 go:uintptrescapes 时编译器会把 x 放到堆上并保持有效，否则 goroutine 扩栈时 x 会被搬走，系统写入的结果就丢了。
//
//go:uintptrescapes
func (o com) call0(i int) int32 {
	r, _, _ := syscall.SyscallN(o.fn(i), uintptr(o.p))
	return int32(r)
}

//go:uintptrescapes
func (o com) call1(i int, a uintptr) int32 {
	r, _, _ := syscall.SyscallN(o.fn(i), uintptr(o.p), a)
	return int32(r)
}

//go:uintptrescapes
func (o com) call2(i int, a, b uintptr) int32 {
	r, _, _ := syscall.SyscallN(o.fn(i), uintptr(o.p), a, b)
	return int32(r)
}

func (o com) release() {
	if o.p != nil {
		o.call0(unknownRelease)
	}
}

// out0 / out1 调用返回一个 COM 对象的方法；失败或没有时返回空对象。
func (o com) out0(i int) com {
	var p unsafe.Pointer
	if o.call1(i, uintptr(unsafe.Pointer(&p))) < 0 {
		return com{}
	}
	return com{p}
}

func (o com) out1(i int, a uintptr) com {
	var p unsafe.Pointer
	if o.call2(i, a, uintptr(unsafe.Pointer(&p))) < 0 {
		return com{}
	}
	return com{p}
}

func (o com) query(iid *guid) com {
	var p unsafe.Pointer
	if o.call2(unknownQueryInterface, uintptr(unsafe.Pointer(iid)), uintptr(unsafe.Pointer(&p))) < 0 {
		return com{}
	}
	return com{p}
}

// bstr 调用返回 BSTR 的方法，转成 Go 字符串并释放。
func (o com) bstr(i int) string {
	var b unsafe.Pointer
	if o.call1(i, uintptr(unsafe.Pointer(&b))) < 0 || b == nil {
		return ""
	}
	defer procSysFreeString.Call(uintptr(b))
	n, _, _ := procSysStringLen.Call(uintptr(b))
	return syscall.UTF16ToString(unsafe.Slice((*uint16)(b), int(n)))
}

func (o com) int32(i int) int32 {
	var v int32
	if o.call1(i, uintptr(unsafe.Pointer(&v))) < 0 {
		return 0
	}
	return v
}

func (o com) ptr(i int) uintptr {
	var v uintptr
	if o.call1(i, uintptr(unsafe.Pointer(&v))) < 0 {
		return 0
	}
	return v
}

type rect struct{ left, top, right, bottom int32 }

func (o com) rect(i int) rect {
	var r rect
	o.call1(i, uintptr(unsafe.Pointer(&r)))
	return r
}

// pattern 取元素支持的模式（如可点击、可填写），不支持时返回空对象。
func (o com) pattern(id int, iid *guid) com {
	unk := o.out1(elemGetCurrentPattern, uintptr(id))
	if !unk.ok() {
		return com{}
	}
	defer unk.release()
	return unk.query(iid)
}

func allocBSTR(s string) uintptr {
	p, _ := syscall.UTF16PtrFromString(s)
	b, _, _ := procSysAllocString.Call(uintptr(unsafe.Pointer(p)))
	return b
}

// processName 进程的程序名（不含 .exe），取不到时返回空字符串。
func processName(pid uint32) string {
	h, _, _ := procOpenProcess.Call(processQueryLimitedInfo, 0, uintptr(pid))
	if h == 0 {
		return ""
	}
	defer procCloseHandle.Call(h)
	buf := make([]uint16, 520)
	n := uint32(len(buf))
	if r, _, _ := procQueryFullProcessImageNameW.Call(h, 0, uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&n))); r == 0 {
		return ""
	}
	path := syscall.UTF16ToString(buf[:n])
	for i := len(path) - 1; i >= 0; i-- {
		if path[i] == '\\' || path[i] == '/' {
			path = path[i+1:]
			break
		}
	}
	if len(path) > 4 && (path[len(path)-4:] == ".exe" || path[len(path)-4:] == ".EXE") {
		path = path[:len(path)-4]
	}
	return path
}
