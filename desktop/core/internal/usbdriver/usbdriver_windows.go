//go:build windows

package usbdriver

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Supported 当前系统能不能检测和安装驱动
const Supported = true

const (
	cmProbFailedInstall = 28 // CM_PROB_FAILED_INSTALL：没有装驱动
	cmProbNotConfigured = 1  // CM_PROB_NOT_CONFIGURED
	dnHasProblem        = 0x00000400
)

var (
	cacheMu   sync.Mutex
	cacheAt   time.Time
	cacheList []Device
)

// Missing 已插上、但 ADB 接口还没有驱动的手机。结果缓存 2 秒（界面每秒查询一次状态）。
func Missing() []Device {
	cacheMu.Lock()
	defer cacheMu.Unlock()
	if time.Since(cacheAt) < 2*time.Second {
		return cacheList
	}
	cacheList, _ = scan()
	cacheAt = time.Now()
	return cacheList
}

func scan() ([]Device, error) {
	set, err := windows.SetupDiGetClassDevsEx(nil, "USB", 0, windows.DIGCF_PRESENT|windows.DIGCF_ALLCLASSES, 0, "")
	if err != nil {
		return nil, err
	}
	defer set.Close()
	var out []Device
	for i := 0; ; i++ {
		d, err := set.EnumDeviceInfo(i)
		if err != nil {
			if errors.Is(err, windows.ERROR_NO_MORE_ITEMS) {
				break
			}
			continue
		}
		ids, _ := set.DeviceRegistryProperty(d, windows.SPDRP_COMPATIBLEIDS)
		list, _ := ids.([]string)
		if !hasADBInterface(list) || hasDriver(set, d) {
			continue
		}
		name := regString(set, d, windows.SPDRP_FRIENDLYNAME)
		if name == "" {
			name = regString(set, d, windows.SPDRP_DEVICEDESC)
		}
		id, _ := set.DeviceInstanceID(d)
		out = append(out, Device{Name: name, InstanceID: id})
	}
	return out, nil
}

// hasDriver 设备有没有装上可用的驱动
func hasDriver(set windows.DevInfo, d *windows.DevInfoData) bool {
	var status, problem uint32
	if windows.CM_Get_DevNode_Status(&status, &problem, d.DevInst, 0) == nil && status&dnHasProblem != 0 {
		if problem == cmProbFailedInstall || problem == cmProbNotConfigured {
			return false
		}
	}
	return regString(set, d, windows.SPDRP_SERVICE) != ""
}

func regString(set windows.DevInfo, d *windows.DevInfoData, p windows.SPDRP) string {
	v, err := set.DeviceRegistryProperty(d, p)
	if err != nil {
		return ""
	}
	s, _ := v.(string)
	return s
}

var (
	modNewdev                          = windows.NewLazySystemDLL("newdev.dll")
	procUpdateDriverForPlugAndPlayDevs = modNewdev.NewProc("UpdateDriverForPlugAndPlayDevicesW")
	modShell32                         = windows.NewLazySystemDLL("shell32.dll")
	procShellExecuteExW                = modShell32.NewProc("ShellExecuteExW")
)

// Install 安装驱动（需要管理员权限，由 InstallElevated 启动的提权进程调用）。
// 只给「当前驱动不如这个好」的设备装，已经装了厂商驱动的手机不受影响。
func Install(dir string) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	inf := filepath.Join(dir, "p2d_android_adb.inf")
	if err := os.WriteFile(inf, []byte(INF()), 0o644); err != nil {
		return err
	}
	hwid, _ := windows.UTF16PtrFromString(ADBCompatibleID)
	infPath, _ := windows.UTF16PtrFromString(inf)
	var reboot int32
	r, _, e := procUpdateDriverForPlugAndPlayDevs.Call(0, uintptr(unsafe.Pointer(hwid)), uintptr(unsafe.Pointer(infPath)), 0, uintptr(unsafe.Pointer(&reboot)))
	if r != 0 {
		return nil
	}
	switch errno, _ := e.(syscall.Errno); errno {
	case windows.ERROR_NO_SUCH_DEVINST:
		return errors.New("没有找到需要安装驱动的手机，请确认手机已插上并开启了 USB 调试")
	case windows.ERROR_NO_MORE_ITEMS:
		return errors.New("手机已经装有驱动，不需要再安装")
	case windows.ERROR_CANCELLED:
		return errors.New("驱动安装被取消了")
	case 0:
		return errors.New("驱动安装失败")
	default:
		return fmt.Errorf("驱动安装失败：%v", e)
	}
}

// installResult 提权进程写回的结果
type installResult struct {
	OK      bool   `json:"ok"`
	Message string `json:"message"`
}

// RunInstallCommand 提权进程的入口（p2d-core -install-adb-driver <结果文件>）：安装后把结果写进文件
func RunInstallCommand(resultFile string) int {
	err := Install(filepath.Join(os.TempDir(), "p2d-adb-driver"))
	res := installResult{OK: err == nil}
	if err != nil {
		res.Message = err.Error()
	}
	b, _ := json.Marshal(res)
	_ = os.WriteFile(resultFile, b, 0o644)
	if err != nil {
		return 1
	}
	return 0
}

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

// InstallElevated 以管理员身份运行本程序安装驱动（弹出 UAC 确认），等它装完返回结果
func InstallElevated() error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	f, err := os.CreateTemp("", "p2d-driver-*.json")
	if err != nil {
		return err
	}
	resultFile := f.Name()
	f.Close()
	defer os.Remove(resultFile)

	verb, _ := windows.UTF16PtrFromString("runas")
	file, _ := windows.UTF16PtrFromString(exe)
	params, _ := windows.UTF16PtrFromString(`-install-adb-driver "` + resultFile + `"`)
	info := shellExecuteInfo{fMask: seeMaskNoCloseProcess | seeMaskNoAsync, lpVerb: verb, lpFile: file, lpParameters: params, nShow: windows.SW_HIDE}
	info.cbSize = uint32(unsafe.Sizeof(info))
	if r, _, e := procShellExecuteExW.Call(uintptr(unsafe.Pointer(&info))); r == 0 {
		if errno, _ := e.(syscall.Errno); errno == windows.ERROR_CANCELLED {
			return errors.New("没有获得管理员权限：安装驱动需要在弹出的窗口中点「是」")
		}
		return fmt.Errorf("无法以管理员身份运行：%v", e)
	}
	if info.hProcess == 0 {
		return errors.New("无法以管理员身份运行")
	}
	defer windows.CloseHandle(info.hProcess)
	if ev, _ := windows.WaitForSingleObject(info.hProcess, uint32((10 * time.Minute).Milliseconds())); ev != windows.WAIT_OBJECT_0 {
		return errors.New("驱动安装超时")
	}
	b, err := os.ReadFile(resultFile)
	var res installResult
	if err != nil || json.Unmarshal(b, &res) != nil {
		return errors.New("驱动安装失败（没有拿到结果）")
	}
	cacheMu.Lock()
	cacheAt = time.Time{} // 装完立即重新检测
	cacheMu.Unlock()
	if !res.OK {
		return errors.New(res.Message)
	}
	return nil
}
