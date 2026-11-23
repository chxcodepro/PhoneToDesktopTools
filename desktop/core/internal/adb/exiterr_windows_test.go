package adb

import (
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"
)

// 子进程模式：以指定的退出码退出，模拟 Windows 加载程序失败
func TestMain(m *testing.M) {
	if c := os.Getenv("P2D_TEST_EXIT"); c != "" {
		n, _ := strconv.ParseUint(c, 0, 32)
		os.Exit(int(int32(uint32(n))))
	}
	os.Exit(m.Run())
}

func TestExplainExit(t *testing.T) {
	for code, want := range map[string]string{
		"0xC0000135": "KB2999226",
		"0xC0000139": "不支持当前的 Windows",
		"0xC000007B": "已损坏",
		"3":          "",
	} {
		cmd := exec.Command(os.Args[0], "-test.run=^$")
		cmd.Env = append(os.Environ(), "P2D_TEST_EXIT="+code)
		err := cmd.Run()
		got := explainExit(err)
		if want == "" && got != "" || want != "" && !strings.Contains(got, want) {
			t.Errorf("退出码 %s：得到 %q，应包含 %q", code, got, want)
		}
	}
	if explainExit(nil) != "" {
		t.Error("没有错误时应返回空串")
	}
}
