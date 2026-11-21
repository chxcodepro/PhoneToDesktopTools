package server

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"p2d/core/internal/perm"
)

func TestSafeJoin(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "s")
	for _, bad := range []string{"", "../x", "a/../../x", "/etc/passwd", `C:\Windows\x`, `..\x`} {
		if _, err := safeJoin(dir, bad); err == nil {
			t.Errorf("应拒绝 %q", bad)
		}
	}
	p, err := safeJoin(dir, "scripts/run.ps1")
	if err != nil || p != filepath.Join(dir, "scripts", "run.ps1") {
		t.Fatalf("got %q %v", p, err)
	}
}

func TestSkillSync(t *testing.T) {
	t.Setenv("P2D_SKILL_DIR", t.TempDir())
	s := &Session{perms: perm.Permissions{Level: perm.Full, Shell: true, FS: true, Screen: true, Input: true}}
	b64 := func(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) }
	params, _ := json.Marshal(map[string]any{
		"name": "巡检", "hash": "0123456789abcdef",
		"files": []map[string]string{{"path": "SKILL.md", "data": b64("---\nname: x\n---")}, {"path": "scripts/a.bat", "data": b64("echo hi")}},
	})
	has, _ := s.skillHas(params)
	if has.(map[string]any)["exists"].(bool) {
		t.Fatal("同步前不应存在")
	}
	res, err := s.skillSync(params)
	if err != nil {
		t.Fatal(err)
	}
	dir := res.(map[string]any)["dir"].(string)
	if b, err := os.ReadFile(filepath.Join(dir, "scripts", "a.bat")); err != nil || string(b) != "echo hi" {
		t.Fatalf("文件没写对：%v %q", err, b)
	}
	has, _ = s.skillHas(params)
	if !has.(map[string]any)["exists"].(bool) {
		t.Fatal("同步后应存在")
	}

	bad, _ := json.Marshal(map[string]any{"name": "x", "hash": "aaaaaaaa", "files": []map[string]string{{"path": "../evil", "data": b64("x")}}})
	if _, err := s.skillSync(bad); err == nil {
		t.Fatal("应拒绝跳出目录的路径")
	}
	ro := &Session{perms: perm.Permissions{Level: perm.ReadOnly}}
	if _, err := ro.skillSync(params); err == nil {
		t.Fatal("只读权限不应允许写入")
	}
}
