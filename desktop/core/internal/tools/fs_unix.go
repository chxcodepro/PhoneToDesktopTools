//go:build !windows

package tools

import (
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

func listDrives() []string { return []string{"/"} }

func isHidden(dir, name string, info fs.FileInfo) bool {
	return strings.HasPrefix(name, ".")
}

// moveToTrash 按 freedesktop 回收站规范移到 ~/.local/share/Trash（麒麟 UKUI 文件管理器可见、可还原）。
func moveToTrash(path string) error {
	abs, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	dataHome := os.Getenv("XDG_DATA_HOME")
	if dataHome == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return err
		}
		dataHome = filepath.Join(home, ".local", "share")
	}
	trash := filepath.Join(dataHome, "Trash")
	filesDir := filepath.Join(trash, "files")
	infoDir := filepath.Join(trash, "info")
	if err := os.MkdirAll(filesDir, 0o700); err != nil {
		return err
	}
	if err := os.MkdirAll(infoDir, 0o700); err != nil {
		return err
	}

	base := filepath.Base(abs)
	name := base
	for i := 1; ; i++ {
		_, e1 := os.Lstat(filepath.Join(filesDir, name))
		_, e2 := os.Lstat(filepath.Join(infoDir, name+".trashinfo"))
		if os.IsNotExist(e1) && os.IsNotExist(e2) {
			break
		}
		ext := filepath.Ext(base)
		name = fmt.Sprintf("%s.%d%s", strings.TrimSuffix(base, ext), i, ext)
	}

	// Path 按规范做 URL 编码，但保留 /
	u := (&url.URL{Path: abs}).EscapedPath()
	info := fmt.Sprintf("[Trash Info]\nPath=%s\nDeletionDate=%s\n", u, time.Now().Format("2006-01-02T15:04:05"))
	infoPath := filepath.Join(infoDir, name+".trashinfo")
	if err := os.WriteFile(infoPath, []byte(info), 0o600); err != nil {
		return err
	}
	if err := os.Rename(abs, filepath.Join(filesDir, name)); err != nil {
		_ = os.Remove(infoPath)
		if errors.Is(err, syscall.EXDEV) {
			return fmt.Errorf("文件与回收站不在同一磁盘分区，无法移到回收站（可用 shell_exec 直接删除）")
		}
		return err
	}
	return nil
}
