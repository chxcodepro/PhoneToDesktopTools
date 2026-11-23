package adb

import (
	"errors"
	"os/exec"
)

// Windows 加载程序失败时，进程的退出码是 NTSTATUS。把常见的几种翻译成用户能看懂、能照着处理的说明。
const (
	statusDLLNotFound        = 0xC0000135 // 缺少依赖的 DLL
	statusEntryPointNotFound = 0xC0000139 // DLL 里没有需要的函数（程序比系统新）
	statusBadImageFormat     = 0xC000007B // 32/64 位不匹配或文件损坏
)

// explainExit adb 进程因为无法加载而退出时返回说明，其他情况返回空串
func explainExit(err error) string {
	var ee *exec.ExitError
	if !errors.As(err, &ee) {
		return ""
	}
	switch uint32(ee.ExitCode()) {
	case statusDLLNotFound:
		return "adb 无法运行：缺少系统运行库。Win7 请安装系统更新 KB2999226，或重新下载完整的电脑端程序"
	case statusEntryPointNotFound:
		return "adb 无法运行：这个版本的 adb 不支持当前的 Windows 系统，请使用电脑端自带的 adb"
	case statusBadImageFormat:
		return "adb 无法运行：文件已损坏或与系统不匹配，请重新下载完整的电脑端程序"
	}
	return ""
}
