package server

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"sync"
)

// TokenStore 管理每台手机的连接令牌。令牌由 adb 通过显式 Deep Link 下发给 App。
type TokenStore struct {
	mu       sync.Mutex
	bySerial map[string]string // 序列号 → 令牌
	devToken string            // 开发调试用的固定令牌
}

// DevSerial 开发令牌对应的虚拟序列号。
const DevSerial = "dev"

func NewTokenStore(devToken string) *TokenStore {
	return &TokenStore{bySerial: map[string]string{}, devToken: devToken}
}

// Issue 为设备生成新令牌（旧令牌作废）。
func (t *TokenStore) Issue(serial string) string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	tok := hex.EncodeToString(b)
	t.mu.Lock()
	t.bySerial[serial] = tok
	t.mu.Unlock()
	return tok
}

// Revoke 作废设备的令牌。
func (t *TokenStore) Revoke(serial string) {
	t.mu.Lock()
	delete(t.bySerial, serial)
	t.mu.Unlock()
}

// RevokeAll 作废所有令牌（开发令牌除外）。
func (t *TokenStore) RevokeAll() {
	t.mu.Lock()
	t.bySerial = map[string]string{}
	t.mu.Unlock()
}

// Lookup 校验令牌，返回对应的设备序列号。
func (t *TokenStore) Lookup(tok string) (string, bool) {
	if tok == "" {
		return "", false
	}
	if t.devToken != "" && subtle.ConstantTimeCompare([]byte(tok), []byte(t.devToken)) == 1 {
		return DevSerial, true
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	for serial, v := range t.bySerial {
		if subtle.ConstantTimeCompare([]byte(tok), []byte(v)) == 1 {
			return serial, true
		}
	}
	return "", false
}
