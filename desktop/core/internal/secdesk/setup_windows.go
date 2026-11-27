//go:build windows

package secdesk

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

// 开启 / 关闭锁屏远程支持：电脑端（普通用户）弹出系统的提权窗口，以管理员身份运行自己的 secure-setup 命令，结果写进临时文件。

// Install 开启（弹出提权窗口），完成后返回。
func Install() error { return elevate("install") }

// Uninstall 关闭（弹出提权窗口），完成后返回。
func Uninstall() error { return elevate("uninstall") }

type setupResult struct {
	OK      bool   `json:"ok"`
	Message string `json:"message,omitempty"`
}

var (
	modShell32          = windows.NewLazySystemDLL("shell32.dll")
	procShellExecuteExW = modShell32.NewProc("ShellExecuteExW")
)

type shellExecuteInfo struct {
	cbSize       uint32
	fMask        uint32
	hwnd         windows.Handle
	lpVerb       *uint16
	lpFile       *uint16
	lpParameters *uint16
	lpDirectory  *uint16
	nShow        int32
	hInstApp     windows.Handle
	lpIDList     uintptr
	lpClass      *uint16
	hkeyClass    windows.Handle
	dwHotKey     uint32
	hIcon        windows.Handle
	hProcess     windows.Handle
}

const (
	seeMaskNoCloseProcess = 0x00000040
	seeMaskNoAsync        = 0x00000100
)

func elevate(op string) error {
	defer invalidateStatus()
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	f, err := os.CreateTemp("", "p2d-secure-*.json")
	if err != nil {
		return err
	}
	resultFile := f.Name()
	f.Close()
	defer os.Remove(resultFile)

	verb, _ := windows.UTF16PtrFromString("runas")
	file, _ := windows.UTF16PtrFromString(exe)
	params, _ := windows.UTF16PtrFromString("secure-setup " + op + " " + syscall.EscapeArg(resultFile))
	info := shellExecuteInfo{fMask: seeMaskNoCloseProcess | seeMaskNoAsync, lpVerb: verb, lpFile: file, lpParameters: params, nShow: windows.SW_HIDE}
	info.cbSize = uint32(unsafe.Sizeof(info))
	if r, _, e := procShellExecuteExW.Call(uintptr(unsafe.Pointer(&info))); r == 0 {
		if errno, _ := e.(syscall.Errno); errno == windows.ERROR_CANCELLED {
			return errors.New("没有获得管理员权限：需要在弹出的窗口中点「是」")
		}
		return fmt.Errorf("无法以管理员身份运行：%v", e)
	}
	if info.hProcess == 0 {
		return errors.New("无法以管理员身份运行")
	}
	defer windows.CloseHandle(info.hProcess)
	if ev, _ := windows.WaitForSingleObject(info.hProcess, uint32((2 * time.Minute).Milliseconds())); ev != windows.WAIT_OBJECT_0 {
		return errors.New("操作超时")
	}
	b, err := os.ReadFile(resultFile)
	var res setupResult
	if err != nil || json.Unmarshal(b, &res) != nil {
		return errors.New("操作失败（没有拿到结果）")
	}
	if !res.OK {
		return errors.New(res.Message)
	}
	return nil
}

// runSetup 以管理员身份运行：secure-setup install|uninstall <结果文件>
func runSetup(args []string) int {
	if len(args) != 2 {
		return 2
	}
	var err error
	switch args[0] {
	case "install":
		err = doInstall()
	case "uninstall":
		err = doUninstall()
	default:
		return 2
	}
	res := setupResult{OK: err == nil}
	if err != nil {
		res.Message = err.Error()
	}
	b, _ := json.Marshal(res)
	_ = os.WriteFile(args[1], b, 0o644)
	if err != nil {
		return 1
	}
	return 0
}

// doInstall 复制程序到 Program Files，登记并启动服务（已经登记过就更新程序后重新启动）
func doInstall() error {
	self, err := os.Executable()
	if err != nil {
		return err
	}
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("打开服务管理器失败：%v", err)
	}
	defer m.Disconnect()
	s, err := m.OpenService(ServiceName)
	if err == nil {
		stopService(s)
	}
	dst := serviceExe()
	if err := os.MkdirAll(serviceDir(), 0o755); err != nil {
		return fmt.Errorf("创建 %s 失败：%v", serviceDir(), err)
	}
	if err := copyFile(self, dst); err != nil {
		if s != nil {
			s.Close()
		}
		return fmt.Errorf("复制程序到 %s 失败：%v", dst, err)
	}
	if s == nil {
		s, err = m.CreateService(ServiceName, dst, mgr.Config{
			DisplayName: serviceDisplay,
			Description: serviceDesc,
			StartType:   mgr.StartAutomatic,
		}, "secure-service")
		if err != nil {
			return fmt.Errorf("登记服务失败：%v", err)
		}
	} else {
		cfg, err := s.Config()
		if err == nil {
			cfg.BinaryPathName = syscall.EscapeArg(dst) + " secure-service"
			cfg.StartType = mgr.StartAutomatic
			cfg.DisplayName, cfg.Description = serviceDisplay, serviceDesc
			err = s.UpdateConfig(cfg)
		}
		if err != nil {
			s.Close()
			return fmt.Errorf("更新服务失败：%v", err)
		}
	}
	defer s.Close()
	// 服务意外退出时 5 秒后重新启动
	_ = s.SetRecoveryActions([]mgr.RecoveryAction{
		{Type: mgr.ServiceRestart, Delay: 5 * time.Second},
		{Type: mgr.ServiceRestart, Delay: 5 * time.Second},
		{Type: mgr.ServiceRestart, Delay: 30 * time.Second},
	}, 24*60*60)
	if err := s.Start(); err != nil {
		return fmt.Errorf("启动服务失败：%v", err)
	}
	return nil
}

// doUninstall 停止并删除服务，删掉 Program Files 里的程序
func doUninstall() error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("打开服务管理器失败：%v", err)
	}
	defer m.Disconnect()
	if s, err := m.OpenService(ServiceName); err == nil {
		stopService(s)
		err := s.Delete()
		s.Close()
		if err != nil {
			return fmt.Errorf("删除服务失败：%v", err)
		}
	}
	dir := serviceDir()
	for i := 0; i < 10; i++ {
		if err = os.RemoveAll(dir); err == nil {
			break
		}
		time.Sleep(500 * time.Millisecond)
	}
	if err != nil {
		// 删不掉（程序还没完全退出）就等重启时删
		p, _ := windows.UTF16PtrFromString(serviceExe())
		_ = windows.MoveFileEx(p, nil, windows.MOVEFILE_DELAY_UNTIL_REBOOT)
		log.Printf("删除 %s 失败：%v，重启后删除", dir, err)
	}
	_ = os.Remove(filepath.Dir(dir)) // P2D 目录空了就删掉
	return nil
}

// stopService 停止服务，最多等 15 秒
func stopService(s *mgr.Service) {
	st, err := s.Query()
	if err != nil || st.State == svc.Stopped {
		return
	}
	_, _ = s.Control(svc.Stop)
	for i := 0; i < 30; i++ {
		time.Sleep(500 * time.Millisecond)
		if st, err := s.Query(); err != nil || st.State == svc.Stopped {
			return
		}
	}
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	tmp := dst + ".new"
	out, err := os.Create(tmp)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		os.Remove(tmp)
		return err
	}
	if err := out.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	var last error
	for i := 0; i < 10; i++ { // 旧的服务进程刚退出时文件可能还占着
		if last = os.Rename(tmp, dst); last == nil {
			return nil
		}
		time.Sleep(500 * time.Millisecond)
	}
	os.Remove(tmp)
	return last
}
