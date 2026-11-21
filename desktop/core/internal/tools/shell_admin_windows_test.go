//go:build windows

package tools

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// 管理员执行用的批处理：不提权直接运行，检查输出、退出码、% 变量和中文路径。
func TestAdminScript(t *testing.T) {
	dir := t.TempDir()
	cwd := filepath.Join(t.TempDir(), "中文 目录")
	if err := os.MkdirAll(cwd, 0o755); err != nil {
		t.Fatal(err)
	}
	bat, err := writeAdminScript(dir, `echo 你好 %OS% & echo 错误 1>&2 & exit /b 3`, cwd)
	if err != nil {
		t.Fatal(err)
	}
	if err := exec.Command("cmd.exe", "/D", "/C", bat).Run(); err != nil {
		t.Fatalf("运行批处理失败：%v", err)
	}
	out := readLimited(filepath.Join(dir, "out.txt"), 1024)
	if !strings.Contains(out, "你好 Windows_NT") {
		t.Fatalf("标准输出不对：%q", out)
	}
	if e := readLimited(filepath.Join(dir, "err.txt"), 1024); !strings.Contains(e, "错误") {
		t.Fatalf("错误输出不对：%q", e)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "code.txt")); strings.TrimSpace(string(b)) != "3" {
		t.Fatalf("退出码不对：%q", b)
	}
}
