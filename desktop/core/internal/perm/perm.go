// Package perm 定义手机端下发的电脑权限，以及工具调用前的权限判断。
package perm

import "fmt"

// Level 权限级别。
type Level string

const (
	ReadOnly Level = "readonly" // 只读
	Standard Level = "standard" // 标准：可写文件、键鼠
	Full     Level = "full"     // 完全控制：含执行命令、删除
)

// Category 工具类别，对应手机端的四个开关（sys 不受开关控制）。
type Category string

const (
	CatSys    Category = "sys"
	CatShell  Category = "shell"
	CatFS     Category = "fs"
	CatScreen Category = "screen"
	CatInput  Category = "input"
)

// Kind 工具的危险程度。
type Kind int

const (
	Read      Kind = iota // 只读
	Write                 // 修改（写文件、键鼠）
	Dangerous             // 高危（执行命令、删除）
)

// Permissions 由手机端通过 p2d/setPermissions 设置。
type Permissions struct {
	Level  Level `json:"level"`
	Shell  bool  `json:"shell"`
	FS     bool  `json:"fs"`
	Screen bool  `json:"screen"`
	Input  bool  `json:"input"`
}

// Default 连接建立后、手机端未设置前的默认权限：只读。
func Default() Permissions {
	return Permissions{Level: ReadOnly, Shell: true, FS: true, Screen: true, Input: true}
}

// Validate 校验手机端传来的权限。
func (p Permissions) Validate() error {
	switch p.Level {
	case ReadOnly, Standard, Full:
		return nil
	default:
		return fmt.Errorf("未知的权限级别：%q", p.Level)
	}
}

// Allow 判断某类工具在当前权限下能否调用；不允许时返回给 Agent 看的原因。
func (p Permissions) Allow(cat Category, kind Kind) (bool, string) {
	switch cat {
	case CatShell:
		if !p.Shell {
			return false, "手机端已关闭「执行命令」权限"
		}
	case CatFS:
		if !p.FS {
			return false, "手机端已关闭「读写文件」权限"
		}
	case CatScreen:
		if !p.Screen {
			return false, "手机端已关闭「查看屏幕」权限"
		}
	case CatInput:
		if !p.Input {
			return false, "手机端已关闭「鼠标键盘」权限"
		}
	}
	switch p.Level {
	case ReadOnly:
		if kind != Read {
			return false, "当前为「只读」权限，请在手机端设置中提高权限级别"
		}
	case Standard:
		if kind == Dangerous {
			return false, "当前为「标准」权限，执行命令和删除文件需要「完全控制」"
		}
	case Full:
	default:
		return false, "权限未设置"
	}
	return true, ""
}
