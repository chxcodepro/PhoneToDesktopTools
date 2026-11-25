// Package portres 识别「端口被 Windows 保留」：开着 Hyper-V、WSL2、Docker 时，WinNAT 服务会预留一段段端口（每次开机随机），
// 这些端口没有程序占用，netstat 也看不到，但任何程序都监听不了（错误 10013 WSAEACCES）。adb 的 5037、本程序的 39271 都可能被划进去。
package portres

import (
	"errors"
	"fmt"
	"runtime"
	"strings"
	"syscall"
)

// wsaeacces Windows 的 WSAEACCES：以一种访问权限不允许的方式做了一个访问套接字的尝试
const wsaeacces = syscall.Errno(10013)

// Reserved 监听端口失败是不是因为端口被 Windows 保留
func Reserved(err error) bool {
	return runtime.GOOS == "windows" && errors.Is(err, wsaeacces)
}

// ReservedOutput 其他程序（adb）的输出里是不是「端口被保留、绑定失败」
func ReservedOutput(out string) bool {
	if !strings.Contains(out, "cannot bind") {
		return false
	}
	return strings.Contains(out, "10013") || strings.Contains(out, "访问权限不允许") || strings.Contains(out, "forbidden by its access permissions")
}

// Hint 告诉用户怎么把端口从保留范围里要回来（管理员命令提示符里依次运行）
func Hint(port, count int) string {
	return fmt.Sprintf("端口 %d 被 Windows 保留了（开着 Hyper-V、WSL 或 Docker 时常见，netstat 里看不到占用）。"+
		"请用管理员身份打开命令提示符，依次运行：net stop winnat、"+
		"netsh int ipv4 add excludedportrange protocol=tcp startport=%d numberofports=%d、net start winnat，然后重新打开本程序", port, port, count)
}
