//go:build windows

package uia

// 程序没在运行时，按名称找到它并启动（window_activate 用）：
// 开始菜单和桌面上的快捷方式（按显示的名称，系统程序用本地化名称，如「记事本」；也按快捷方式指向的程序名，如 Weixin），
// 再找 App Paths 注册表和 PATH。启动前先确认同一个程序没在运行，避免多开。

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"unicode/utf16"
	"unsafe"
)

var (
	shell32                  = syscall.NewLazyDLL("shell32.dll")
	shlwapi                  = syscall.NewLazyDLL("shlwapi.dll")
	procShellExecuteExW      = shell32.NewProc("ShellExecuteExW")
	procSHLoadIndirectString = shlwapi.NewProc("SHLoadIndirectString")

	clsidShellLink = guid{0x00021401, 0, 0, [8]byte{0xc0, 0, 0, 0, 0, 0, 0, 0x46}}
	iidShellLinkW  = guid{0x000214f9, 0, 0, [8]byte{0xc0, 0, 0, 0, 0, 0, 0, 0x46}}
	iidPersistFile = guid{0x0000010b, 0, 0, [8]byte{0xc0, 0, 0, 0, 0, 0, 0, 0x46}}
)

const (
	shellLinkGetPath   = 3 // IShellLinkW::GetPath
	persistFileLoad    = 5 // IPersistFile::Load
	seeMaskNoAsync     = 0x00000100
	seeMaskFlagNoUI    = 0x00000400
	swShowNormal       = 1
	maxShortcutDepth   = 3
	maxShortcutResults = 2000
)

// program 找到的程序
type program struct {
	name string // 显示的名称
	path string // 要打开的文件（快捷方式或程序）
	exe  string // 实际的程序名（小写，不含 .exe）；不知道时为空
}

type shortcut struct {
	path  string
	names []string // 显示的名称（本地化名称在前）和文件名
}

// shortcutDirs 开始菜单（当前用户、所有用户）和桌面；桌面只看第一层
func shortcutDirs() []struct {
	dir   string
	depth int
} {
	type d = struct {
		dir   string
		depth int
	}
	var out []d
	add := func(base, sub string, depth int) {
		if base != "" {
			out = append(out, d{filepath.Join(base, sub), depth})
		}
	}
	add(os.Getenv("APPDATA"), `Microsoft\Windows\Start Menu\Programs`, maxShortcutDepth)
	add(os.Getenv("ProgramData"), `Microsoft\Windows\Start Menu\Programs`, maxShortcutDepth)
	add(os.Getenv("USERPROFILE"), "Desktop", 0)
	add(os.Getenv("PUBLIC"), "Desktop", 0)
	return out
}

func shortcuts() []shortcut {
	var out []shortcut
	for _, d := range shortcutDirs() {
		root := d.dir
		localized := map[string]map[string]string{}
		_ = filepath.WalkDir(root, func(p string, e os.DirEntry, err error) error {
			if err != nil || len(out) >= maxShortcutResults {
				return nil
			}
			if e.IsDir() {
				if rel, _ := filepath.Rel(root, p); rel != "." && strings.Count(rel, `\`) >= d.depth {
					return filepath.SkipDir
				}
				return nil
			}
			if !strings.EqualFold(filepath.Ext(p), ".lnk") {
				return nil
			}
			dir := filepath.Dir(p)
			names, ok := localized[dir]
			if !ok {
				names = localizedNames(dir)
				localized[dir] = names
			}
			base := e.Name()
			s := shortcut{path: p}
			if n := names[strings.ToLower(base)]; n != "" {
				s.names = append(s.names, n)
			}
			s.names = append(s.names, strings.TrimSuffix(base, filepath.Ext(base)))
			out = append(out, s)
			return nil
		})
	}
	return out
}

// localizedNames 读目录里 desktop.ini 的 [LocalizedFileNames]：文件名（小写）→ 显示的名称（如 Notepad.lnk → 记事本）
func localizedNames(dir string) map[string]string {
	b, err := os.ReadFile(filepath.Join(dir, "desktop.ini"))
	if err != nil {
		return nil
	}
	text := decodeIni(b)
	out := map[string]string{}
	in := false
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "[") {
			in = strings.EqualFold(line, "[LocalizedFileNames]")
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !in || !ok {
			continue
		}
		v = strings.TrimSpace(v)
		if strings.HasPrefix(v, "@") {
			v = indirectString(expandEnv(v))
		}
		if v != "" {
			out[strings.ToLower(strings.TrimSpace(k))] = v
		}
	}
	return out
}

// decodeIni desktop.ini 一般是带 BOM 的 UTF-16LE
func decodeIni(b []byte) string {
	if len(b) >= 2 && b[0] == 0xff && b[1] == 0xfe {
		u := make([]uint16, (len(b)-2)/2)
		for i := range u {
			u[i] = uint16(b[2+2*i]) | uint16(b[3+2*i])<<8
		}
		return string(utf16.Decode(u))
	}
	return string(b)
}

func expandEnv(s string) string {
	for {
		i := strings.Index(s, "%")
		if i < 0 {
			return s
		}
		j := strings.Index(s[i+1:], "%")
		if j < 0 {
			return s
		}
		v := os.Getenv(s[i+1 : i+1+j])
		if v == "" {
			return s
		}
		s = s[:i] + v + s[i+2+j:]
	}
}

// indirectString 读取「@shell32.dll,-22563」这种资源字符串
func indirectString(src string) string {
	if procSHLoadIndirectString.Find() != nil {
		return ""
	}
	p, err := syscall.UTF16PtrFromString(src)
	if err != nil {
		return ""
	}
	buf := make([]uint16, 260)
	if r, _, _ := procSHLoadIndirectString.Call(uintptr(unsafe.Pointer(p)), uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)), 0); int32(r) < 0 {
		return ""
	}
	return syscall.UTF16ToString(buf)
}

// lnkTarget 快捷方式指向的文件；取不到（如商店应用、安装器广告的快捷方式）返回空
func lnkTarget(path string) string {
	var sl com
	r, _, _ := procCoCreateInstance.Call(uintptr(unsafe.Pointer(&clsidShellLink)), 0, clsctxInprocServer,
		uintptr(unsafe.Pointer(&iidShellLinkW)), uintptr(unsafe.Pointer(&sl.p)))
	if int32(r) < 0 || !sl.ok() {
		return ""
	}
	defer sl.release()
	pf := sl.query(&iidPersistFile)
	if !pf.ok() {
		return ""
	}
	defer pf.release()
	p, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return ""
	}
	if pf.call2(persistFileLoad, uintptr(unsafe.Pointer(p)), 0) < 0 {
		return ""
	}
	buf := make([]uint16, 1024)
	r, _, _ = syscall.SyscallN(sl.fn(shellLinkGetPath), uintptr(sl.p), uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)), 0, 0)
	if int32(r) != 0 {
		return ""
	}
	return syscall.UTF16ToString(buf)
}

// exeName 程序文件名（小写，不含 .exe）；不是 .exe 返回空
func exeName(path string) string {
	base := strings.ToLower(filepath.Base(path))
	if !strings.HasSuffix(base, ".exe") {
		return ""
	}
	return strings.TrimSuffix(base, ".exe")
}

// uninstaller 卸载程序的快捷方式不能当成程序本身
func uninstaller(name string) bool {
	n := strings.ToLower(name)
	return strings.Contains(n, "卸载") || strings.Contains(n, "uninstall") || strings.Contains(n, "解除安裝")
}

// findProgram 按名称找没在运行的程序
func findProgram(want string) (program, bool) {
	w := strings.TrimSuffix(strings.ToLower(strings.TrimSpace(want)), ".exe")
	if w == "" {
		return program{}, false
	}
	list := shortcuts()
	best, bestRank := -1, 1
	for i, s := range list {
		for _, n := range s.names {
			if uninstaller(n) {
				continue
			}
			if r := trayRank(n, w); r > bestRank {
				best, bestRank = i, r
			}
		}
	}
	if best >= 0 {
		s := list[best]
		return program{name: s.names[0], path: s.path, exe: exeName(lnkTarget(s.path))}, true
	}
	// 按快捷方式指向的程序名找（如 Weixin → 微信.lnk）
	for _, s := range list {
		if uninstaller(s.names[0]) {
			continue
		}
		if t := lnkTarget(s.path); t != "" && exeName(t) == w {
			return program{name: s.names[0], path: s.path, exe: w}, true
		}
	}
	if strings.ContainsAny(w, `\/:`) {
		return program{}, false
	}
	if p := appPath(w + ".exe"); p != "" {
		return program{name: want, path: p, exe: exeName(p)}, true
	}
	if p, err := exec.LookPath(w); err == nil && filepath.IsAbs(p) {
		return program{name: want, path: p, exe: exeName(p)}, true
	}
	return program{}, false
}

// appPath 注册表 App Paths 里登记的程序路径
func appPath(exe string) string {
	sub, _ := syscall.UTF16PtrFromString(`SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\` + exe)
	for _, root := range []syscall.Handle{syscall.HKEY_CURRENT_USER, syscall.HKEY_LOCAL_MACHINE} {
		var k syscall.Handle
		if syscall.RegOpenKeyEx(root, sub, 0, syscall.KEY_READ, &k) != nil {
			continue
		}
		var typ uint32
		buf := make([]uint16, 1024)
		n := uint32(len(buf) * 2)
		err := syscall.RegQueryValueEx(k, nil, nil, &typ, (*byte)(unsafe.Pointer(&buf[0])), &n)
		syscall.RegCloseKey(k)
		if err != nil || (typ != syscall.REG_SZ && typ != syscall.REG_EXPAND_SZ) {
			continue
		}
		p := strings.Trim(expandEnv(syscall.UTF16ToString(buf)), `"`)
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return ""
}

// processRunning 有没有这个程序名（小写，不含 .exe）的进程
func processRunning(exe string) bool {
	h, err := syscall.CreateToolhelp32Snapshot(syscall.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return false
	}
	defer syscall.CloseHandle(h)
	var pe syscall.ProcessEntry32
	pe.Size = uint32(unsafe.Sizeof(pe))
	for err = syscall.Process32First(h, &pe); err == nil; err = syscall.Process32Next(h, &pe) {
		if exeName(syscall.UTF16ToString(pe.ExeFile[:])) == exe {
			return true
		}
	}
	return false
}

// SHELLEXECUTEINFOW
type shellExecuteInfo struct {
	cbSize       uint32
	fMask        uint32
	hwnd         uintptr
	lpVerb       *uint16
	lpFile       *uint16
	lpParameters *uint16
	lpDirectory  *uint16
	nShow        int32
	hInstApp     uintptr
	lpIDList     uintptr
	lpClass      *uint16
	hkeyClass    uintptr
	dwHotKey     uint32
	hIcon        uintptr
	hProcess     syscall.Handle
}

// shellOpen 像双击一样打开快捷方式或程序
func shellOpen(path string) error {
	file, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	verb, _ := syscall.UTF16PtrFromString("open")
	info := shellExecuteInfo{fMask: seeMaskNoAsync | seeMaskFlagNoUI, lpVerb: verb, lpFile: file, nShow: swShowNormal}
	if !strings.EqualFold(filepath.Ext(path), ".lnk") {
		info.lpDirectory, _ = syscall.UTF16PtrFromString(filepath.Dir(path))
	}
	info.cbSize = uint32(unsafe.Sizeof(info))
	if r, _, e := procShellExecuteExW.Call(uintptr(unsafe.Pointer(&info))); r == 0 {
		if e != nil && e != syscall.Errno(0) {
			return e
		}
		return errors.New("系统没有打开它")
	}
	return nil
}
