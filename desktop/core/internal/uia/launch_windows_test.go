//go:build windows

package uia

import (
	"context"
	"os"
	"runtime"
	"testing"
)

// 不依赖本机装了什么程序的部分
func TestLaunchHelpers(t *testing.T) {
	if got := exeName(`D:\soft\Weixin\Weixin.exe`); got != "weixin" {
		t.Errorf("exeName = %q", got)
	}
	if got := exeName(`C:\a\readme.txt`); got != "" {
		t.Errorf("非 exe 应返回空：%q", got)
	}
	for _, n := range []string{"卸载微信", "Uninstall QQ"} {
		if !uninstaller(n) {
			t.Errorf("%s 应当是卸载程序", n)
		}
	}
	if uninstaller("微信") {
		t.Error("微信不是卸载程序")
	}
	ini := []byte{0xff, 0xfe, '[', 0, 'L', 0, ']', 0}
	if got := decodeIni(ini); got != "[L]" {
		t.Errorf("decodeIni = %q", got)
	}
	os.Setenv("P2D_TEST_DIR", `C:\x`)
	if got := expandEnv(`@%P2D_TEST_DIR%\a.dll,-1`); got != `@C:\x\a.dll,-1` {
		t.Errorf("expandEnv = %q", got)
	}
	if !processRunning(exeName(os.Args[0])) {
		t.Error("应当能找到测试进程自己")
	}
	if processRunning("p2d-no-such-program") {
		t.Error("不存在的程序不应在运行")
	}
	if p, ok := findProgram("cmd"); !ok || p.exe != "cmd" {
		t.Errorf("找不到 cmd：%+v", p)
	}
	if _, ok := findProgram("p2d-no-such-program"); ok {
		t.Error("不存在的程序不应找到")
	}
}

// 手动：P2D_FIND=1 时列出本机按名称找到的程序（只查找，不启动）
func TestManualFindProgram(t *testing.T) {
	if os.Getenv("P2D_FIND") == "" {
		t.Skip("未设置 P2D_FIND")
	}
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	procCoInitializeEx.Call(0, coinitMultithreaded)
	defer procCoUninitialize.Call()
	for _, n := range []string{"微信", "Weixin", "QQ", "QQ音乐", "记事本", "notepad", "画图", "不存在的程序"} {
		p, ok := findProgram(n)
		t.Logf("%-8s → %v %+v 运行中=%v", n, ok, p, p.exe != "" && processRunning(p.exe))
	}
}

// 手动：P2D_LAUNCH=程序名 时真的打开它（没在运行就启动），再调一次确认不会重复启动
func TestManualLaunch(t *testing.T) {
	name := os.Getenv("P2D_LAUNCH")
	if name == "" {
		t.Skip("未设置 P2D_LAUNCH")
	}
	for i := 0; i < 2; i++ {
		out, err := Run(context.Background(), Params{Mode: "activate", Window: name, Restore: true, Launch: true})
		t.Logf("第 %d 次：%s %v", i+1, out, err)
	}
	out, err := Run(context.Background(), Params{Mode: "activate", Window: "p2d-no-such-program", Restore: true, Launch: true})
	t.Logf("不存在：%q %v", out, err)
}
