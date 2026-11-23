//go:build !windows

package usbdriver

import "errors"

// Supported 当前系统能不能检测和安装驱动（Linux 不需要驱动，只需要 udev 权限）
const Supported = false

// Missing Linux 不需要驱动，总是空
func Missing() []Device { return nil }

// InstallElevated 只有 Windows 需要
func InstallElevated() error { return errors.New("只有 Windows 需要安装手机驱动") }

// RunInstallCommand 只有 Windows 需要
func RunInstallCommand(string) int { return 1 }
