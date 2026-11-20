//go:build !windows && !linux

package input

import "errors"

var errUnsupported = errors.New("当前系统不支持键鼠控制")

func Move(x, y int) error              { return errUnsupported }
func Press(b Button, down bool) error  { return errUnsupported }
func Scroll(dy int) error              { return errUnsupported }
func TypeText(s string) error          { return errUnsupported }
func Combo(keys []string) error        { return errUnsupported }
