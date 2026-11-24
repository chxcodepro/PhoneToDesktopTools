// Package lan 局域网直连：手机输入电脑 IP（或扫码）直接连接，不经过 adb。
//
// 安全设计（docs/PROTOCOL.md 第 9 节）：
//   - 每台手机和电脑配对后共享一个 32 字节密钥 K（插数据线时经 adb 下发；或扫码 / 配对码配对时用 X25519 协商）；
//   - 每次连接双方各出 16 字节随机数，用 HKDF 从 K 派生两个方向的会话密钥，之后所有消息用 ChaCha20-Poly1305 加密，
//     nonce 为每个方向递增的计数器；能解开第一条消息即证明对方持有 K；
//   - 配对码模式用 X25519 + 短认证码（双方从协商结果算出 6 位数字，用户在手机上输入电脑显示的码来核对，防中间人），
//     并且只在用户在电脑上点了「配对新手机」后的几分钟内接受；扫码模式二维码里带一次性的高强度随机密钥。
package lan

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"hash"
	"io"

	"golang.org/x/crypto/chacha20poly1305"
)

// HKDF（RFC 5869，SHA-256）。Go 1.20 标准库还没有。
func HKDF(ikm, salt, info []byte, n int) []byte {
	if len(salt) == 0 {
		salt = make([]byte, sha256.Size)
	}
	ext := hmac.New(sha256.New, salt)
	ext.Write(ikm)
	prk := ext.Sum(nil)
	var out, t []byte
	for i := byte(1); len(out) < n; i++ {
		h := hmac.New(sha256.New, prk)
		h.Write(t)
		h.Write(info)
		h.Write([]byte{i})
		t = h.Sum(nil)
		out = append(out, t...)
	}
	return out[:n]
}

// HMAC-SHA256
func MAC(key []byte, parts ...[]byte) []byte {
	h := hmac.New(sha256.New, key)
	for _, p := range parts {
		h.Write(p)
	}
	return h.Sum(nil)
}

// Transcript 配对时双方公钥和身份的摘要，后续派生都绑定它。
func Transcript(pubPhone, pubPC []byte, phoneID, pcID string) []byte {
	h := sha256.New()
	for _, p := range [][]byte{[]byte("p2d pair v1"), pubPhone, pubPC, []byte(phoneID), []byte(pcID)} {
		writeLen(h, p)
	}
	return h.Sum(nil)
}

func writeLen(h hash.Hash, p []byte) {
	var l [4]byte
	binary.BigEndian.PutUint32(l[:], uint32(len(p)))
	h.Write(l[:])
	h.Write(p)
}

// SAS 配对码模式的 6 位短认证码。
func SAS(shared, transcript []byte) string {
	b := HKDF(shared, transcript, []byte("p2d sas"), 4)
	return fmt.Sprintf("%06d", binary.BigEndian.Uint32(b)%1_000_000)
}

// SessionKeys 由配对密钥和双方随机数派生两个方向的会话密钥。
func SessionKeys(k, nonceC, nonceS []byte) (c2s, s2c []byte) {
	okm := HKDF(k, append(append([]byte{}, nonceC...), nonceS...), []byte("p2d secure v1"), 64)
	return okm[:32], okm[32:]
}

// 帧类型（明文第一个字节）
const (
	FrameText   byte = 1
	FrameBinary byte = 2
)

// Cipher 一个方向的加密 / 解密状态（计数器 nonce）。非并发安全，由调用方串行使用。
type Cipher struct {
	impl    cipherImpl
	counter uint64
}

type cipherImpl interface {
	Seal(dst, nonce, plaintext, additionalData []byte) []byte
	Open(dst, nonce, ciphertext, additionalData []byte) ([]byte, error)
}

// CipherAESGCM 手机端在握手时可以要求改用 AES-256-GCM：手机上 AES 有硬件加速、由系统原生代码执行，
// 而 ChaCha20 只能用 JavaScript 计算（虚拟桌面每帧上百 KB，解密就要上百毫秒）。密钥、nonce 规则和 ChaCha20 相同。
const CipherAESGCM = "aes-gcm"

// NewCipherFor 按握手时商定的算法创建：aes-gcm 或默认的 ChaCha20-Poly1305。
func NewCipherFor(name string, key []byte) (*Cipher, error) {
	if name != CipherAESGCM {
		return NewCipher(key)
	}
	b, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	g, err := cipher.NewGCM(b)
	if err != nil {
		return nil, err
	}
	return &Cipher{impl: g}, nil
}

// NewCipher 用 32 字节密钥创建（ChaCha20-Poly1305）。
func NewCipher(key []byte) (*Cipher, error) {
	a, err := chacha20poly1305.New(key)
	if err != nil {
		return nil, err
	}
	return &Cipher{impl: a}, nil
}

func (c *Cipher) nonce() []byte {
	n := make([]byte, chacha20poly1305.NonceSize)
	binary.BigEndian.PutUint64(n[4:], c.counter)
	c.counter++
	return n
}

// Seal 加密一帧：明文 = 类型字节 + 内容。
func (c *Cipher) Seal(typ byte, payload []byte) []byte {
	pt := make([]byte, 1+len(payload))
	pt[0] = typ
	copy(pt[1:], payload)
	return c.impl.Seal(nil, c.nonce(), pt, nil)
}

// ErrDecrypt 解密失败（密钥不对或数据被篡改）。
var ErrDecrypt = errors.New("解密失败")

// Open 解密一帧。
func (c *Cipher) Open(frame []byte) (byte, []byte, error) {
	pt, err := c.impl.Open(nil, c.nonce(), frame, nil)
	if err != nil || len(pt) == 0 {
		return 0, nil, ErrDecrypt
	}
	return pt[0], pt[1:], nil
}

// Random 读取随机字节。
func Random(r io.Reader, n int) []byte {
	b := make([]byte, n)
	if _, err := io.ReadFull(r, b); err != nil {
		panic(err)
	}
	return b
}
