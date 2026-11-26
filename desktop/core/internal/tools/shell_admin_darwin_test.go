//go:build darwin

package tools

import "testing"

func TestAdminAppleScript(t *testing.T) {
	got := adminAppleScript(`echo "hi" \ 'x'`, "/Users/a b")
	want := `do shell script "cd '/Users/a b' && echo \"hi\" \ 'x'" with administrator privileges without altering line endings`
	if got != want {
		t.Fatalf("\n得到 %s\n应为 %s", got, want)
	}
}
