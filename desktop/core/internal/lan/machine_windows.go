//go:build windows

package lan

import (
	"syscall"
	"unsafe"
)

// systemMachineID 读 HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid（Win7 起都有）。
// 用 KEY_WOW64_64KEY 读 64 位视图：32 位程序跑在 64 位系统上时也能读到；32 位系统会忽略这个标志。
// 只读 HKLM，不受 MSIX 打包程序的注册表 / 文件重定向影响。
func systemMachineID() string {
	sub, _ := syscall.UTF16PtrFromString(`SOFTWARE\Microsoft\Cryptography`)
	var h syscall.Handle
	if syscall.RegOpenKeyEx(syscall.HKEY_LOCAL_MACHINE, sub, 0, syscall.KEY_READ|syscall.KEY_WOW64_64KEY, &h) != nil {
		return ""
	}
	defer syscall.RegCloseKey(h)
	name, _ := syscall.UTF16PtrFromString("MachineGuid")
	buf := make([]uint16, 128)
	n := uint32(len(buf) * 2)
	var typ uint32
	if syscall.RegQueryValueEx(h, name, nil, &typ, (*byte)(unsafe.Pointer(&buf[0])), &n) != nil || typ != syscall.REG_SZ {
		return ""
	}
	return syscall.UTF16ToString(buf[:n/2])
}
