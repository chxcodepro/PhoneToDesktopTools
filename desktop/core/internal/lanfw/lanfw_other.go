//go:build !linux

package lanfw

import "errors"

// Supported Windows 防火墙由系统在第一次监听时自己弹窗询问，不需要处理
const Supported = false

// Blocked 只处理 Linux（银河麒麟）
func Blocked(int) bool { return false }

// Allow 只处理 Linux（银河麒麟）
func Allow(int) error { return errors.New("只有银河麒麟需要手动放行防火墙") }
