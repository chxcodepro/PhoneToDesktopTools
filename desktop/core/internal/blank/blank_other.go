//go:build !windows

package blank

import "errors"

// Supported 这个系统能不能黑屏，不能时返回原因
func Supported() error {
	return errors.New("这台电脑的系统暂不支持黑屏（目前只支持 Windows 10 2004 及以上）")
}

// Show 打开黑屏
func Show() error { return Supported() }

// Hide 关闭黑屏
func Hide() {}

// On 是否开着黑屏
func On() bool { return false }
