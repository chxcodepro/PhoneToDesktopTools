package server

import (
	"encoding/json"
	"strings"
	"testing"

	"p2d/core/internal/tools"
)

func TestCallLine(t *testing.T) {
	ok := &tools.Result{Content: []tools.Content{{Type: "text", Text: "输出很长\n不该出现"}}}
	bad := &tools.Result{IsError: true, Content: []tools.Content{{Type: "text", Text: "没有找到「微信」的窗口\n或托盘图标"}}}

	for _, tc := range []struct {
		name, tool, args string
		res              *tools.Result
		want, notWant    []string
	}{
		{"失败记原因", "window_activate", `{"name":"微信"}`, bad,
			[]string{`调用 window_activate 失败（12 ms）`, `name="微信"`, `→ 没有找到「微信」的窗口 或托盘图标`}, nil},
		{"命令记参数不记输出", "shell_exec", `{"command":"where weixin","timeout_sec":30}`, ok,
			[]string{`command="where weixin"`, `timeout_sec=30`}, []string{"输出很长", "→"}},
		{"键盘输入只记长度", "input_keyboard", `{"action":"type","text":"我的密码123"}`, ok,
			[]string{`action="type"`, `text=（7 字）`}, []string{"密码"}},
		{"写文件不记内容", "fs_write", `{"path":"D:\\a.txt","content":"秘密"}`, ok,
			[]string{`content=（2 字）`, `path="D:\\a.txt"`}, []string{"秘密"}},
		{"没有参数", "sys_info", ``, ok, []string{"调用 sys_info 成功（12 ms）"}, []string{"="}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := callLine(tc.tool, json.RawMessage(tc.args), tc.res, 12)
			for _, w := range tc.want {
				if !strings.Contains(got, w) {
					t.Errorf("%q 里没有 %q", got, w)
				}
			}
			for _, w := range tc.notWant {
				if strings.Contains(got, w) {
					t.Errorf("%q 里不该有 %q", got, w)
				}
			}
		})
	}
}
