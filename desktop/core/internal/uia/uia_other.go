//go:build !windows

package uia

import (
	"context"
	"errors"
)

// Run 非 Windows 系统暂不支持（麒麟等 Linux 计划用 AT-SPI 实现）。
func Run(ctx context.Context, p Params) (string, error) {
	return "", errors.New("当前系统暂不支持读取界面元素，请用 screen_capture 截图后按坐标操作")
}
