//go:build windows

package tools

import (
	"fmt"
	"io/fs"
	"path/filepath"
	"runtime"
	"syscall"
	"unsafe"
)

var (
	modKernel32         = syscall.NewLazyDLL("kernel32.dll")
	modShell32          = syscall.NewLazyDLL("shell32.dll")
	procGetLogicalDrive = modKernel32.NewProc("GetLogicalDrives")
	procGetDriveTypeW   = modKernel32.NewProc("GetDriveTypeW")
	procSHFileOperation = modShell32.NewProc("SHFileOperationW")
)

func listDrives() []string {
	mask, _, _ := procGetLogicalDrive.Call()
	names := map[uintptr]string{2: "可移动磁盘", 3: "本地磁盘", 4: "网络驱动器", 5: "光驱", 6: "内存盘"}
	var out []string
	for i := 0; i < 26; i++ {
		if mask&(1<<uint(i)) == 0 {
			continue
		}
		root := fmt.Sprintf("%c:\\", 'A'+i)
		p, _ := syscall.UTF16PtrFromString(root)
		t, _, _ := procGetDriveTypeW.Call(uintptr(unsafe.Pointer(p)))
		kind := names[t]
		if kind == "" {
			kind = "未知"
		}
		out = append(out, fmt.Sprintf("%s  %s", root, kind))
	}
	return out
}

func isHidden(dir, name string, info fs.FileInfo) bool {
	if sys, ok := info.Sys().(*syscall.Win32FileAttributeData); ok {
		return sys.FileAttributes&(syscall.FILE_ATTRIBUTE_HIDDEN|syscall.FILE_ATTRIBUTE_SYSTEM) != 0
	}
	return len(name) > 0 && name[0] == '.'
}

// moveToTrash 调用 SHFileOperationW(FO_DELETE, FOF_ALLOWUNDO) 移到回收站。
// SHFILEOPSTRUCTW 在 32 位下按 1 字节对齐、64 位下按 8 字节对齐，因此手工按偏移填充。
func moveToTrash(path string) error {
	abs, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	from, err := syscall.UTF16FromString(abs)
	if err != nil {
		return err
	}
	from = append(from, 0) // 双 NUL 结尾

	const (
		foDelete  = 3
		fofFlags  = 0x0004 | 0x0010 | 0x0040 | 0x0400 // SILENT | NOCONFIRMATION | ALLOWUNDO | NOERRORUI
		ptrSize   = unsafe.Sizeof(uintptr(0))
		is64      = ptrSize == 8
		bufLength = 64
	)
	var buf [bufLength]byte
	putU32 := func(off uintptr, v uint32) { *(*uint32)(unsafe.Pointer(&buf[off])) = v }
	putU16 := func(off uintptr, v uint16) { *(*uint16)(unsafe.Pointer(&buf[off])) = v }
	putPtr := func(off uintptr, v uintptr) { *(*uintptr)(unsafe.Pointer(&buf[off])) = v }

	pFrom := uintptr(unsafe.Pointer(&from[0]))
	if is64 {
		putU32(8, foDelete)
		putPtr(16, pFrom)
		putU16(32, fofFlags)
	} else {
		putU32(4, foDelete)
		putPtr(8, pFrom)
		putU16(16, fofFlags)
	}
	ret, _, _ := procSHFileOperation.Call(uintptr(unsafe.Pointer(&buf[0])))
	runtime.KeepAlive(from)
	if ret != 0 {
		return fmt.Errorf("SHFileOperation 返回错误码 0x%x", ret)
	}
	var aborted uint32
	if is64 {
		aborted = *(*uint32)(unsafe.Pointer(&buf[36]))
	} else {
		aborted = *(*uint32)(unsafe.Pointer(&buf[18]))
	}
	if aborted != 0 {
		return fmt.Errorf("操作被取消")
	}
	return nil
}
