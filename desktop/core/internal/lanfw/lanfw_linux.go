//go:build linux

package lanfw

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Supported 当前系统可能有需要放行的防火墙
const Supported = true

var kylinFirewall = "/usr/sbin/kylin-firewall"

var cache struct {
	sync.Mutex
	at      time.Time
	port    int
	blocked bool
}

// Blocked 系统防火墙会不会挡住手机连 port（结果缓存 5 秒，每秒的状态轮询不会反复启动进程）
func Blocked(port int) bool {
	cache.Lock()
	defer cache.Unlock()
	if cache.port == port && time.Since(cache.at) < 5*time.Second {
		return cache.blocked
	}
	cache.port, cache.at, cache.blocked = port, time.Now(), check(port)
	return cache.blocked
}

func check(port int) bool {
	if _, err := os.Stat(kylinFirewall); err != nil {
		return false
	}
	modes, err := exec.Command(kylinFirewall, "-g").Output()
	if err != nil {
		return false
	}
	rules, err := exec.Command(kylinFirewall, "-S").Output()
	if err != nil {
		return false
	}
	return blocked(string(modes), string(rules), port)
}

// Allow 弹出系统的管理员密码框，添加放行 port 的规则（公用、专用两种模式都放行）
func Allow(port int) error {
	pkexec, err := exec.LookPath("pkexec")
	if err != nil {
		return errors.New("找不到 pkexec，请在「安全中心 → 防火墙 → 配置访问规则」里手动放行 TCP 端口 " + strconv.Itoa(port))
	}
	rules, _ := exec.Command(kylinFirewall, "-S").Output()
	args := []string{kylinFirewall, "-A", RuleName, "-d", "inbound", "-m", "all", "-p", "tcp", "-L", strconv.Itoa(port), "-a", "allow"}
	if hasRule(string(rules)) {
		// 规则还在、只是被关掉了（或端口不对）：直接开启。端口不对的情况先删掉重建会多弹一次密码框，这里不处理
		args = []string{kylinFirewall, "--set-rule", RuleName, "on"}
	}
	out, err := exec.Command(pkexec, args...).CombinedOutput()
	cache.Lock()
	cache.at = time.Time{}
	cache.Unlock()
	var ee *exec.ExitError
	switch {
	case err == nil:
	case errors.As(err, &ee) && (ee.ExitCode() == 126 || ee.ExitCode() == 127):
		return errors.New("没有获得管理员权限：放行需要在弹出的窗口中输入当前用户的密码")
	default:
		return fmt.Errorf("放行失败：%v %s", err, strings.TrimSpace(string(out)))
	}
	if Blocked(port) {
		return errors.New("规则已添加，但防火墙仍然没有放行，请在「安全中心 → 防火墙 → 配置访问规则」里检查端口 " + strconv.Itoa(port))
	}
	return nil
}
