package sysinfo

import "testing"

func TestWindowsName(t *testing.T) {
	for _, c := range []struct {
		major, minor, build uint32
		want                string
	}{
		{10, 0, 26100, "Windows 11"},
		{10, 0, 22000, "Windows 11"},
		{10, 0, 19045, "Windows 10"},
		{6, 1, 7601, "Windows 7"},
		{6, 3, 9600, "Windows 8.1"},
	} {
		if got := windowsName(c.major, c.minor, c.build); got != c.want {
			t.Errorf("%d.%d.%d = %s，应为 %s", c.major, c.minor, c.build, got, c.want)
		}
	}
}

func TestMacName(t *testing.T) {
	for _, c := range []struct{ ver, full, short string }{
		{"14.5", "macOS 14.5", "macOS 14"},
		{"26.0.1", "macOS 26.0.1", "macOS 26"},
		{"10.15.7", "macOS 10.15.7", "macOS 10.15"},
		{"10.13", "macOS 10.13", "macOS 10.13"},
		{"", "macOS", "macOS"},
	} {
		if full, short := macName(c.ver); full != c.full || short != c.short {
			t.Errorf("%q = %s / %s，应为 %s / %s", c.ver, full, short, c.full, c.short)
		}
	}
}
