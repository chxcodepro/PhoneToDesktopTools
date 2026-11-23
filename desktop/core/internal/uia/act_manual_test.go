//go:build windows

package uia

import (
	"context"
	"os"
	"testing"
)

// 手动：P2D_UIA_ACT=1 时操作「无标题 - 记事本」（需先自己打开一个空白记事本）
func TestManualAct(t *testing.T) {
	if os.Getenv("P2D_UIA_ACT") == "" {
		t.Skip("未设置 P2D_UIA_ACT")
	}
	ctx := context.Background()
	w := "无标题 - 记事本"
	steps := []Params{
		{Mode: "tree", Window: w, Max: 40},
		{Mode: "act", Window: w, Name: "文本编辑器", Action: "set_value", Value: "来自手机的问候 hello"},
		{Mode: "tree", Window: w, Type: "编辑"},
		{Mode: "act", Window: w, Name: "格式", Action: "click"},
		{Mode: "tree", Window: w, Name: "自动换行"},
		{Mode: "act", Window: w, Name: "自动换行", Action: "click"},
		{Mode: "act", Window: w, Name: "格式", Action: "click"},
		{Mode: "tree", Window: w, Name: "自动换行"},
	}
	for _, p := range steps {
		p.Restore = true
		out, err := Run(ctx, p)
		t.Logf("%s %s %s → err=%v\n%s", p.Mode, p.Name, p.Action, err, out)
	}
}
