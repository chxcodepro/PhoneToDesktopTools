//go:build windows

// Package wincom 用纯 Go（不用 cgo）调用 Windows 的 COM 接口：DXGI 桌面复制、Direct3D 11、Media Foundation。
// 接口方法按虚函数表序号调用，序号对照 Windows SDK 头文件里接口声明的顺序（含继承的父接口方法）。
package wincom

import (
	"fmt"
	"syscall"
	"unsafe"
)

const ptrSize = unsafe.Sizeof(uintptr(0))

// GUID 接口 / 类的编号。
type GUID struct {
	D1     uint32
	D2, D3 uint16
	D4     [8]byte
}

// HRESULT COM 方法的返回值，负数表示失败。
type HRESULT int32

func (h HRESULT) Failed() bool { return h < 0 }

func (h HRESULT) Error() string { return fmt.Sprintf("HRESULT 0x%08X", uint32(h)) }

// Err 失败时返回带说明的错误，成功时返回 nil。
func (h HRESULT) Err(what string) error {
	if h >= 0 {
		return nil
	}
	return fmt.Errorf("%s 失败（0x%08X）", what, uint32(h))
}

// Obj 一个 COM 接口指针（系统分配的内存，不是 Go 内存）。
type Obj struct{ P unsafe.Pointer }

func (o Obj) Nil() bool { return o.P == nil }

// Ptr 作为参数传给其他 COM 方法时用。
func (o Obj) Ptr() uintptr { return uintptr(o.P) }

func (o Obj) fn(i int) uintptr {
	vtbl := *(*unsafe.Pointer)(o.P)
	return *(*uintptr)(unsafe.Add(vtbl, uintptr(i)*ptrSize))
}

// Call 调用第 i 个虚函数（不含 this），返回 HRESULT。
// 指向 Go 变量的参数必须直接在调用处写成 uintptr(unsafe.Pointer(&x))：
// 有 go:uintptrescapes 时编译器会把 x 放到堆上并在调用期间保持有效，否则 goroutine 扩栈时 x 会被搬走，系统写入的结果就丢了。
//
//go:uintptrescapes
func (o Obj) Call(i int, args ...uintptr) HRESULT {
	a := make([]uintptr, 0, len(args)+1)
	a = append(a, uintptr(o.P))
	a = append(a, args...)
	r, _, _ := syscall.SyscallN(o.fn(i), a...)
	return HRESULT(r)
}

// Release 释放接口并清空。
func (o *Obj) Release() {
	if o.P != nil {
		o.Call(2)
		o.P = nil
	}
}

// QueryInterface 取同一对象的另一个接口。
func (o Obj) QueryInterface(iid *GUID) (Obj, error) {
	p, hr := o.Out(0, uintptr(unsafe.Pointer(iid)))
	if hr.Failed() {
		return Obj{}, hr.Err("QueryInterface")
	}
	return p, nil
}

// Out 调用一个最后一个参数是「返回接口指针」的方法。
//
//go:uintptrescapes
func (o Obj) Out(i int, args ...uintptr) (Obj, HRESULT) {
	p := heapPtr() // 接收结果的变量要在堆上，系统写入时它不能被搬走
	a := make([]uintptr, 0, len(args)+2)
	a = append(a, uintptr(o.P))
	a = append(a, args...)
	a = append(a, uintptr(unsafe.Pointer(p)))
	r, _, _ := syscall.SyscallN(o.fn(i), a...)
	if HRESULT(r).Failed() {
		return Obj{}, HRESULT(r)
	}
	return Obj{*p}, HRESULT(r)
}

// heapPtr 在堆上分配一个指针变量（不内联，返回值一定逃逸到堆上）。
//
//go:noinline
func heapPtr() *unsafe.Pointer { return new(unsafe.Pointer) }

// Proc 调用 DLL 导出函数，返回 HRESULT。参数规则同 Call。
//
//go:uintptrescapes
func Proc(p *syscall.LazyProc, args ...uintptr) HRESULT {
	r, _, _ := syscall.SyscallN(p.Addr(), args...)
	return HRESULT(r)
}
