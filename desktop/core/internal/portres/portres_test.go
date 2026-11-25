package portres

import (
	"fmt"
	"net"
	"os"
	"runtime"
	"strings"
	"testing"
)

func TestReservedOutput(t *testing.T) {
	cn := "* daemon not running; starting now at tcp:5037\ncould not read ok from ADB Server\n* failed to start daemon\n" +
		"error: cannot bind listener: cannot bind to 127.0.0.1:5037: 以一种访问权限不允许的方式做了一个访问套接字的尝试。 (10013)"
	if !ReservedOutput(cn) {
		t.Fatal("中文系统的 adb 输出应识别出来")
	}
	if ReservedOutput("error: cannot bind to 127.0.0.1:5037: 通常每个套接字地址只允许使用一次。 (10048)") {
		t.Fatal("真的被占用（10048）不算保留")
	}
	if !strings.Contains(Hint(39271, 2), "startport=39271 numberofports=2") {
		t.Fatal(Hint(39271, 2))
	}
}

func TestReservedErr(t *testing.T) {
	err := &net.OpError{Op: "listen", Net: "tcp", Err: os.NewSyscallError("bind", wsaeacces)}
	if got := Reserved(err); got != (runtime.GOOS == "windows") {
		t.Fatalf("Reserved=%v", got)
	}
	if Reserved(fmt.Errorf("其他错误")) {
		t.Fatal("其他错误不算")
	}
}
