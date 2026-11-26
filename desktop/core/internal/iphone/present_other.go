//go:build !linux && !windows

package iphone

// applePresent macOS 自带 usbmuxd，不需要判断
func applePresent() bool { return false }
