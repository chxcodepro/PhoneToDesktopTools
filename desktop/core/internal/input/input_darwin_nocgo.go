//go:build darwin && !cgo

package input

import "errors"

// Mac 版键鼠要用 cgo 调用 CoreGraphics；没开 cgo 编译时都返回错误。
var errNoCgo = errors.New("这个程序编译时没有启用 cgo，Mac 上不能控制键鼠")

func Move(x, y int) error             { return errNoCgo }
func Press(b Button, down bool) error { return errNoCgo }
func Scroll(dy int) error             { return errNoCgo }
func TypeText(s string) error         { return errNoCgo }
func Combo(keys []string) error       { return errNoCgo }
