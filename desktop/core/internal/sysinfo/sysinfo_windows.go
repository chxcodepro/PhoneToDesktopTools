//go:build windows

// Package sysinfo 获取系统版本、桌面目录等信息。
package sysinfo

import (
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"unsafe"
)

var (
	ntdll              = syscall.NewLazyDLL("ntdll.dll")
	shell32            = syscall.NewLazyDLL("shell32.dll")
	procRtlGetVersion  = ntdll.NewProc("RtlGetVersion")
	procSHGetFolderPat = shell32.NewProc("SHGetFolderPathW")
)

type osVersionInfo struct {
	Size       uint32
	Major      uint32
	Minor      uint32
	Build      uint32
	PlatformID uint32
	CSDVersion [128]uint16
}

func regString(path, name string) string {
	var h syscall.Handle
	p, _ := syscall.UTF16PtrFromString(path)
	if syscall.RegOpenKeyEx(syscall.HKEY_LOCAL_MACHINE, p, 0, syscall.KEY_READ|0x0100 /*WOW64_64KEY*/, &h) != nil {
		return ""
	}
	defer syscall.RegCloseKey(h)
	n, _ := syscall.UTF16PtrFromString(name)
	var typ, size uint32
	if syscall.RegQueryValueEx(h, n, nil, &typ, nil, &size) != nil || size == 0 {
		return ""
	}
	buf := make([]uint16, size/2+1)
	if syscall.RegQueryValueEx(h, n, nil, &typ, (*byte)(unsafe.Pointer(&buf[0])), &size) != nil {
		return ""
	}
	return syscall.UTF16ToString(buf)
}

// OSVersion 例如 "Windows 7 Ultimate Service Pack 1 (6.1.7601)"。
func OSVersion() string {
	var v osVersionInfo
	v.Size = uint32(unsafe.Sizeof(v))
	procRtlGetVersion.Call(uintptr(unsafe.Pointer(&v)))
	name := regString(`SOFTWARE\Microsoft\Windows NT\CurrentVersion`, "ProductName")
	if name == "" {
		name = "Windows"
	}
	sp := syscall.UTF16ToString(v.CSDVersion[:])
	if sp != "" {
		name += " " + sp
	}
	return fmt.Sprintf("%s (%d.%d.%d)", name, v.Major, v.Minor, v.Build)
}

// DesktopDir 当前用户的桌面目录（支持被重定向到其他盘的情况）。
func DesktopDir() string {
	buf := make([]uint16, 520)
	const csidlDesktopDirectory = 0x10
	r, _, _ := procSHGetFolderPat.Call(0, csidlDesktopDirectory, 0, 0, uintptr(unsafe.Pointer(&buf[0])))
	if r == 0 {
		return syscall.UTF16ToString(buf)
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "Desktop")
}

var procIsUserAnAdmin = shell32.NewProc("IsUserAnAdmin")

// IsAdmin 当前进程是否以管理员身份运行（UAC 提升后）。
func IsAdmin() bool {
	if procIsUserAnAdmin.Find() != nil {
		return false
	}
	r, _, _ := procIsUserAnAdmin.Call()
	return r != 0
}
