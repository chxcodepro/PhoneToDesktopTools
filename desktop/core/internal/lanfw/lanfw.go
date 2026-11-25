// Package lanfw 检测并放行系统防火墙对局域网直连端口的拦截。
// 目前只处理银河麒麟自带的 kylin-firewall：它的公用、专用模式默认都拒绝所有入站连接，
// 不放行的话手机无法通过 WiFi 连接电脑（数据线连接走本机回环，不受影响）。
package lanfw

import (
	"strconv"
	"strings"
)

// RuleName 放行规则在麒麟安全中心里显示的名称
const RuleName = "p2d"

// oldRuleNames 改名前用过的规则名：这样的规则还在时直接开启它，不再新建一条
var oldRuleNames = []string{"PhoneToDesktop"}

// rule kylin-firewall -S 输出中的一行
type rule struct {
	name, direction, mode, proto, localPorts, remoteIP, remotePorts, action, status string
}

// parseRules 解析 kylin-firewall -S 的表格：
// rule_name | program | direction | mode | proto | local-IP | local-ports | remote-IP | remote-ports | action | status
func parseRules(out string) []rule {
	var rules []rule
	for _, line := range strings.Split(out, "\n") {
		f := strings.Fields(line)
		if len(f) != 11 || f[0] == "rule_name" {
			continue
		}
		rules = append(rules, rule{
			name: f[0], direction: f[2], mode: f[3], proto: f[4],
			localPorts: f[6], remoteIP: f[7], remotePorts: f[8], action: f[9], status: f[10],
		})
	}
	return rules
}

// parseModes 解析 kylin-firewall -g，返回已开启的模式（public / private）
func parseModes(out string) []string {
	var on []string
	for _, line := range strings.Split(out, "\n") {
		f := strings.Fields(line)
		if len(f) >= 3 && f[1] == "mode" && f[len(f)-1] == "on" {
			on = append(on, f[0])
		}
	}
	return on
}

// portIn 端口是否在 "22"、"25,7250"、"27185:27198"、"all" 这样的列表里
func portIn(list string, port int) bool {
	if list == "all" {
		return true
	}
	for _, p := range strings.Split(list, ",") {
		lo, hi, isRange := strings.Cut(p, ":")
		a, err := strconv.Atoi(lo)
		if err != nil {
			continue
		}
		b := a
		if isRange {
			if b, err = strconv.Atoi(hi); err != nil {
				continue
			}
		}
		if port >= a && port <= b {
			return true
		}
	}
	return false
}

// allows 这条规则是否放行任意来源对本机 TCP 端口 port 的入站连接
func (r rule) allows(port int) bool {
	return r.status == "on" && r.action == "allow" &&
		(r.direction == "all" || r.direction == "inbound" || r.direction == "in") &&
		(r.proto == "all" || r.proto == "tcp") &&
		r.remoteIP == "all" && r.remotePorts == "all" && portIn(r.localPorts, port)
}

// blocked 已开启的模式里有没有一个没放行 port；返回 true 表示手机会被挡住。
// 规则表里同名的 deny 规则优先级我们无法判断，只看有没有放行规则。
func blocked(modesOut, rulesOut string, port int) bool {
	modes := parseModes(modesOut)
	if len(modes) == 0 {
		return false
	}
	covered := map[string]bool{}
	for _, r := range parseRules(rulesOut) {
		if !r.allows(port) {
			continue
		}
		if r.mode == "all" {
			return false
		}
		covered[r.mode] = true
	}
	for _, m := range modes {
		if !covered[m] {
			return true
		}
	}
	return false
}

// ourRule 规则表里我们的规则名（可能被用户关掉了，也可能是改名前的旧名字）；没有返回空
func ourRule(rulesOut string) string {
	rules := parseRules(rulesOut)
	for _, name := range append([]string{RuleName}, oldRuleNames...) {
		for _, r := range rules {
			if r.name == name {
				return name
			}
		}
	}
	return ""
}
