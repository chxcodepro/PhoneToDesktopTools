package uia

import "testing"

func TestTrayRank(t *testing.T) {
	cases := []struct {
		name, want string
		rank       int
	}{
		{"微信", "微信", 3},
		{"QQ: 小明(12345)", "QQ", 2},
		{"微信 - 3 条新消息", "微信", 2},
		{"QQ音乐 听我想听", "QQ", 1},
		{"输入法模式图标 - 单击右键查看微信输入法设置", "微信", 0},
		{"Wallpaper Engine", "wallpaper engine", 3},
		{"", "微信", 0},
	}
	for _, c := range cases {
		if got := trayRank(c.name, c.want); got != c.rank {
			t.Errorf("trayRank(%q, %q) = %d，应为 %d", c.name, c.want, got, c.rank)
		}
	}
}
