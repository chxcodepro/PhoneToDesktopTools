package tools

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"p2d/core/internal/perm"
	"p2d/core/internal/textenc"
)

var full = perm.Permissions{Level: perm.Full, Shell: true, FS: true, Screen: true, Input: true}

func call(t *testing.T, r *Registry, name string, args map[string]any) (string, bool) {
	t.Helper()
	b, _ := json.Marshal(args)
	res, ok := r.Call(context.Background(), full, name, b)
	if !ok {
		t.Fatalf("工具不存在：%s", name)
	}
	var sb strings.Builder
	for _, c := range res.Content {
		sb.WriteString(c.Text)
	}
	return sb.String(), res.IsError
}

func TestEditKeepsGBKAndCRLF(t *testing.T) {
	r := NewRegistry()
	dir := t.TempDir()
	p := filepath.Join(dir, "旧文件.bat")
	gbk, _ := textenc.Encode("@echo off\r\necho 你好\r\npause\r\n", textenc.GBK)
	if err := os.WriteFile(p, gbk, 0o644); err != nil {
		t.Fatal(err)
	}

	txt, isErr := call(t, r, "fs_read", map[string]any{"path": p})
	if isErr || !strings.Contains(txt, "echo 你好") || !strings.Contains(txt, "gbk") {
		t.Fatalf("读取 GBK 文件失败：%s", txt)
	}

	// 模型给的是 LF，文件是 CRLF
	txt, isErr = call(t, r, "fs_edit", map[string]any{"path": p, "old_string": "echo 你好\npause", "new_string": "echo 世界\npause"})
	if isErr {
		t.Fatalf("编辑失败：%s", txt)
	}
	raw, _ := os.ReadFile(p)
	s, enc := textenc.Decode(raw)
	if enc != textenc.GBK {
		t.Fatalf("编码应保持 GBK，实际 %s", enc)
	}
	if s != "@echo off\r\necho 世界\r\npause\r\n" {
		t.Fatalf("内容不对：%q", s)
	}
}

func TestEditRequiresUnique(t *testing.T) {
	r := NewRegistry()
	p := filepath.Join(t.TempDir(), "a.txt")
	_ = os.WriteFile(p, []byte("x\nx\n"), 0o644)
	if txt, isErr := call(t, r, "fs_edit", map[string]any{"path": p, "old_string": "x", "new_string": "y"}); !isErr || !strings.Contains(txt, "2 次") {
		t.Fatalf("重复匹配应报错：%s", txt)
	}
	if _, isErr := call(t, r, "fs_edit", map[string]any{"path": p, "old_string": "x", "new_string": "y", "replace_all": true}); isErr {
		t.Fatal("replace_all 应成功")
	}
	b, _ := os.ReadFile(p)
	if string(b) != "y\ny\n" {
		t.Fatalf("内容不对：%q", b)
	}
}

func TestReadPagingAndSearch(t *testing.T) {
	r := NewRegistry()
	dir := t.TempDir()
	var lines []string
	for i := 1; i <= 30; i++ {
		lines = append(lines, "行"+strings.Repeat("a", i%3))
	}
	_ = os.WriteFile(filepath.Join(dir, "11月-销售.txt"), []byte(strings.Join(lines, "\n")+"\n关键字在这里\n"), 0o644)
	_ = os.WriteFile(filepath.Join(dir, "其他.log"), []byte("无关"), 0o644)

	txt, _ := call(t, r, "fs_read", map[string]any{"path": filepath.Join(dir, "11月-销售.txt"), "offset": 5, "limit": 3})
	if !strings.Contains(txt, "显示第 5-7 行") || !strings.Contains(txt, "offset=8") {
		t.Fatalf("分页不对：%s", txt)
	}
	txt, _ = call(t, r, "fs_search", map[string]any{"path": dir, "name": "*11月*"})
	if !strings.Contains(txt, "11月-销售.txt") || strings.Contains(txt, "其他.log") {
		t.Fatalf("按名称搜索不对：%s", txt)
	}
	txt, _ = call(t, r, "fs_search", map[string]any{"path": dir, "content": "关键字"})
	if !strings.Contains(txt, ":31: 关键字在这里") {
		t.Fatalf("按内容搜索不对：%s", txt)
	}
	txt, _ = call(t, r, "fs_list", map[string]any{"path": dir})
	if !strings.Contains(txt, "2 项") {
		t.Fatalf("列目录不对：%s", txt)
	}
}

func TestBinaryRejected(t *testing.T) {
	r := NewRegistry()
	p := filepath.Join(t.TempDir(), "a.bin")
	_ = os.WriteFile(p, []byte{1, 2, 0, 3}, 0o644)
	if txt, isErr := call(t, r, "fs_read", map[string]any{"path": p}); !isErr || !strings.Contains(txt, "二进制") {
		t.Fatalf("应拒绝二进制：%s", txt)
	}
}

func TestDeleteToTrash(t *testing.T) {
	if os.Getenv("P2D_TEST_TRASH") == "" {
		t.Skip("会真正写入系统回收站，设置 P2D_TEST_TRASH=1 时才运行")
	}
	r := NewRegistry()
	p := filepath.Join(t.TempDir(), "待删除.txt")
	_ = os.WriteFile(p, []byte("x"), 0o644)
	if txt, isErr := call(t, r, "fs_delete", map[string]any{"path": p}); isErr {
		t.Fatalf("删除失败：%s", txt)
	}
	if _, err := os.Stat(p); !os.IsNotExist(err) {
		t.Fatal("文件应已移走")
	}
}

func TestShellTimeoutAndOutput(t *testing.T) {
	r := NewRegistry()
	cmd := "ping -n 30 127.0.0.1"
	if os.PathSeparator == '/' {
		cmd = "sleep 30"
	}
	txt, isErr := call(t, r, "shell_exec", map[string]any{"command": cmd, "timeout_sec": 1})
	if !isErr || !strings.Contains(txt, "超时") {
		t.Fatalf("应超时：%s", txt)
	}
	txt, isErr = call(t, r, "shell_exec", map[string]any{"command": `echo "a b" && echo 中文`})
	if isErr || !strings.Contains(txt, `"a b"`) && !strings.Contains(txt, "a b") || !strings.Contains(txt, "中文") {
		t.Fatalf("输出不对：%s", txt)
	}
}
