package server

import "testing"

func TestTokenUsed(t *testing.T) {
	ts := NewTokenStore("")
	tok := ts.Issue("A")
	if ts.Used(tok) {
		t.Fatal("新令牌还没连过")
	}
	if _, ok := ts.Lookup(tok); !ok || !ts.Used(tok) {
		t.Fatal("用来连接后应记为已用")
	}
	tok2 := ts.Issue("A") // 重新发令牌：旧的作废
	if ts.Used(tok2) {
		t.Fatal("新发的令牌还没连过")
	}
	if _, ok := ts.Lookup(tok); ok {
		t.Fatal("旧令牌应该作废")
	}
	ts.Lookup(tok2)
	ts.Revoke("A")
	if ts.Used(tok2) {
		t.Fatal("作废后不再记录")
	}
}
