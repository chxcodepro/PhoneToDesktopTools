package tools

import (
	"context"
	"encoding/json"
	"testing"

	"p2d/core/internal/perm"
	"p2d/core/internal/uia"
)

// ui_tree 是只读工具：没有操作界面的权限时，不能还原最小化的窗口。
func TestUIRestoreFollowsPermissions(t *testing.T) {
	var got *uia.Params
	old := uiaRun
	uiaRun = func(_ context.Context, p uia.Params) (string, error) {
		got = &p
		return "ok", nil
	}
	t.Cleanup(func() { uiaRun = old })

	r := NewRegistry()
	for _, tc := range []struct {
		name    string
		tool    string
		level   perm.Level
		input   bool
		called  bool
		restore bool
	}{
		{"只读读取", "ui_tree", perm.ReadOnly, true, true, false},
		{"只读且关了键鼠", "ui_tree", perm.ReadOnly, false, true, false},
		{"标准但关了键鼠", "ui_tree", perm.Standard, false, true, false},
		{"完全但关了键鼠", "ui_tree", perm.Full, false, true, false},
		{"标准读取", "ui_tree", perm.Standard, true, true, true},
		{"完全读取", "ui_tree", perm.Full, true, true, true},
		{"标准操作", "ui_act", perm.Standard, true, true, true},
		{"只读操作被拒绝", "ui_act", perm.ReadOnly, true, false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got = nil
			p := perm.Permissions{Level: tc.level, Screen: true, Input: tc.input}
			r.Call(context.Background(), p, tc.tool, json.RawMessage(`{"name":"x","action":"click"}`))
			if (got != nil) != tc.called {
				t.Fatalf("是否执行 = %v，应为 %v", got != nil, tc.called)
			}
			if got != nil && got.Restore != tc.restore {
				t.Fatalf("Restore = %v，应为 %v", got.Restore, tc.restore)
			}
		})
	}

	// 不经过 Registry.Call（ctx 里没有权限）时按不允许处理
	got = nil
	if _, err := uiTree(context.Background(), json.RawMessage(`{}`)); err != nil || got == nil || got.Restore {
		t.Fatalf("缺少权限信息时不应还原：%+v %v", got, err)
	}
}
