package lanfw

import "testing"

// 银河麒麟 V10 SP1 默认规则（kylin-firewall -S 的真实输出，节选）
const kylinRules = `rule_name          | program | direction | mode   | proto | local-IP | local-ports  | remote-IP | remote-ports | action | status
Risk-Ports           all       all         public   all     all        21,23,25,111,427,631 all         all            deny     on
CUPSD                all       all         private  tcp     all        631            all         all            allow    on
SNMP                 all       all         private  udp     all        all            all         161            allow    on
System-Activation    all       all         all      all     all        all            all         7070,17070     allow    on
Kylin-Connectivity   all       all         all      all     all        27180,27181,27182,27185:27198 all         all            allow    on
Remote-Ports         all       all         all      tcp     all        all            all         80,443,59546   allow    on
SSHD                 all       all         private  tcp     all        22             all         all            allow    on
`

const bothOn = `kylin firewall status:
    public mode   --------  on
    private mode  --------  on
`

func TestBlocked(t *testing.T) {
	if !blocked(bothOn, kylinRules, 39272) {
		t.Fatal("默认规则下应判断为被拦截")
	}
	// SSHD 只放行了专用模式，公用模式也开着，所以仍算拦截
	if !blocked(bothOn, kylinRules, 22) {
		t.Fatal("只放行了专用模式，应判断为被拦截")
	}
	if blocked("kylin firewall status:\n    public mode   --------  off\n    private mode  --------  on\n", kylinRules, 22) {
		t.Fatal("只开专用模式时 22 已放行")
	}
	if blocked(bothOn, kylinRules, 27190) {
		t.Fatal("端口范围内应放行")
	}
	if blocked("kylin firewall status:\n    public mode   --------  off\n    private mode  --------  off\n", kylinRules, 39272) {
		t.Fatal("防火墙关闭时不应拦截")
	}
	ours := kylinRules + "p2d                  all       inbound     all      tcp     all        39272          all         all            allow    on \n"
	if blocked(bothOn, ours, 39272) {
		t.Fatal("加了规则后应放行")
	}
	old := kylinRules + "PhoneToDesktop       all       inbound     all      tcp     all        39272          all         all            allow    off \n"
	if ourRule(ours) != "p2d" || ourRule(old) != "PhoneToDesktop" || ourRule(kylinRules) != "" {
		t.Fatal("ourRule 判断错误")
	}
	off := kylinRules + "PhoneToDesktop       all       inbound     all      tcp     all        39272          all         all            allow    off \n"
	if !blocked(bothOn, off, 39272) {
		t.Fatal("规则被关掉时应判断为拦截")
	}
}

func TestPortIn(t *testing.T) {
	for _, c := range []struct {
		list string
		port int
		want bool
	}{{"22", 22, true}, {"25,7250", 7250, true}, {"27185:27198", 27185, true}, {"27185:27198", 27199, false}, {"all", 1, true}, {"x", 1, false}} {
		if got := portIn(c.list, c.port); got != c.want {
			t.Errorf("portIn(%q, %d) = %v", c.list, c.port, got)
		}
	}
}
