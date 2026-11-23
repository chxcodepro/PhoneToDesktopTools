package lan

import "testing"

func TestIsTailscale(t *testing.T) {
	for ip, want := range map[string]bool{
		"100.64.0.1": true, "100.101.102.103": true, "100.127.255.254": true,
		"100.63.255.255": false, "100.128.0.1": false, "192.168.1.5": false, "10.0.0.2": false, "fd7a:115c:a1e0::1": false, "x": false,
	} {
		if got := IsTailscale(ip); got != want {
			t.Errorf("IsTailscale(%q) = %v", ip, got)
		}
	}
}
