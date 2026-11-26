//go:build darwin

package tools

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// listDrives 根目录加上 /Volumes 下挂载的磁盘（U 盘、移动硬盘、网络盘等）。
// /Volumes 里系统盘通常是一个指向 / 的链接，跳过它。
func listDrives() []string {
	out := []string{"/"}
	ents, err := os.ReadDir("/Volumes")
	if err != nil {
		return out
	}
	for _, e := range ents {
		p := filepath.Join("/Volumes", e.Name())
		if t, err := filepath.EvalSymlinks(p); err == nil && t == "/" {
			continue
		}
		out = append(out, p)
	}
	return out
}

// moveToTrash 移到废纸篓：优先让「访达」删除（废纸篓里可以「放回原处」；第一次会询问是否允许 P2D 控制访达），
// 不行时直接移到 ~/.Trash。
func moveToTrash(path string) error {
	abs, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	if _, err := os.Lstat(abs); err != nil {
		return err
	}
	script := `tell application "Finder" to delete (POSIX file ` + appleScriptString(abs) + ` as alias)`
	// 用户迟迟不回答「是否允许控制访达」时不一直等
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	finderErr := exec.CommandContext(ctx, "/usr/bin/osascript", "-e", script).Run()
	if finderErr == nil {
		return nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	trash := filepath.Join(home, ".Trash")
	base := filepath.Base(abs)
	name := base
	for i := 1; ; i++ {
		if _, err := os.Lstat(filepath.Join(trash, name)); os.IsNotExist(err) {
			break
		}
		ext := filepath.Ext(base)
		name = fmt.Sprintf("%s %d%s", strings.TrimSuffix(base, ext), i, ext)
	}
	if err := os.Rename(abs, filepath.Join(trash, name)); err != nil {
		return fmt.Errorf("移到废纸篓失败（访达：%v；直接移动：%v），可用 shell_exec 直接删除", finderErr, err)
	}
	return nil
}
