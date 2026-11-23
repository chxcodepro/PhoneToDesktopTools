package pdftext

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/md5"
	"crypto/rc4"
	"crypto/sha256"
	"crypto/sha512"
	"errors"
	"fmt"
	"hash"
)

// 标准安全处理器：只支持空的打开密码（很多 PDF 只设了「禁止复制 / 打印」的权限密码）。

var passwordPad = []byte{
	0x28, 0xBF, 0x4E, 0x5E, 0x4E, 0x75, 0x8A, 0x41, 0x64, 0x00, 0x4E, 0x56, 0xFF, 0xFA, 0x01, 0x08,
	0x2E, 0x2E, 0x00, 0xB6, 0xD0, 0x68, 0x3E, 0x80, 0x2F, 0x0C, 0xA9, 0xFE, 0x64, 0x53, 0x69, 0x7A,
}

type cryptMethod int

const (
	cmNone cryptMethod = iota
	cmRC4
	cmAESV2
	cmAESV3
)

type decrypter struct {
	key             []byte
	strM, stmM      cryptMethod
	filters         map[string]cryptMethod
	encryptMetadata bool
}

func newDecrypter(enc dict, trailer dict) (*decrypter, error) {
	if f, _ := enc["Filter"].(name); f != "Standard" {
		return nil, fmt.Errorf("不支持的加密方式 %s", f)
	}
	v := intOr(enc["V"], 0)
	r := intOr(enc["R"], 0)
	o, _ := enc["O"].([]byte)
	u, _ := enc["U"].([]byte)
	p := uint32(int32(intOr(enc["P"], 0)))
	c := &decrypter{encryptMetadata: true, filters: map[string]cryptMethod{"Identity": cmNone}}
	if em, ok := enc["EncryptMetadata"].(bool); ok {
		c.encryptMetadata = em
	}
	var id0 []byte
	if ids, ok := trailer["ID"].(array); ok && len(ids) > 0 {
		id0, _ = ids[0].([]byte)
	}

	// 加密方法：V4 / V5 用加密过滤器
	c.strM, c.stmM = cmRC4, cmRC4
	if v >= 4 {
		if cf, ok := enc["CF"].(dict); ok {
			for k, fv := range cf {
				fd, _ := fv.(dict)
				switch fd["CFM"] {
				case name("V2"):
					c.filters[k] = cmRC4
				case name("AESV2"):
					c.filters[k] = cmAESV2
				case name("AESV3"):
					c.filters[k] = cmAESV3
				default:
					c.filters[k] = cmNone
				}
			}
		}
		pick := func(key string) cryptMethod {
			n, ok := enc[key].(name)
			if !ok {
				return cmNone
			}
			return c.filters[string(n)]
		}
		c.strM, c.stmM = pick("StrF"), pick("StmF")
	}

	switch {
	case r >= 5:
		key, err := aes256Key(r, o, u, enc)
		if err != nil {
			return nil, err
		}
		c.key = key
	case r >= 2:
		n := 5
		if r >= 3 {
			n = intOr(enc["Length"], 40) / 8
			if n < 5 || n > 16 {
				n = 16
			}
		}
		h := md5.New()
		h.Write(passwordPad)
		h.Write(pad32(o))
		h.Write([]byte{byte(p), byte(p >> 8), byte(p >> 16), byte(p >> 24)})
		h.Write(id0)
		if r >= 4 && !c.encryptMetadata {
			h.Write([]byte{0xff, 0xff, 0xff, 0xff})
		}
		key := h.Sum(nil)
		if r >= 3 {
			for i := 0; i < 50; i++ {
				s := md5.Sum(key[:n])
				key = s[:]
			}
		}
		key = key[:n]
		if !checkUserR234(key, r, u, id0) {
			return nil, ErrPassword
		}
		c.key = key
	default:
		return nil, fmt.Errorf("不支持的加密版本 R%d", r)
	}
	return c, nil
}

func pad32(b []byte) []byte {
	if len(b) >= 32 {
		return b[:32]
	}
	return append(append([]byte{}, b...), passwordPad[:32-len(b)]...)
}

func rc4Bytes(key, data []byte) []byte {
	c, err := rc4.NewCipher(key)
	if err != nil {
		return data
	}
	out := make([]byte, len(data))
	c.XORKeyStream(out, data)
	return out
}

func checkUserR234(key []byte, r int, u, id0 []byte) bool {
	if len(u) < 16 {
		return true // 无法校验，按空密码继续
	}
	if r == 2 {
		return bytes.Equal(rc4Bytes(key, passwordPad), u[:32])
	}
	h := md5.New()
	h.Write(passwordPad)
	h.Write(id0)
	x := rc4Bytes(key, h.Sum(nil))
	for i := 1; i <= 19; i++ {
		k := make([]byte, len(key))
		for j := range key {
			k[j] = key[j] ^ byte(i)
		}
		x = rc4Bytes(k, x)
	}
	return bytes.Equal(x[:16], u[:16])
}

// aes256Key R5 / R6：用空密码校验用户密码，再解出文件密钥
func aes256Key(r int, o, u []byte, enc dict) ([]byte, error) {
	ue, _ := enc["UE"].([]byte)
	if len(u) < 48 || len(ue) < 32 {
		return nil, errors.New("PDF 加密信息不完整")
	}
	var check, inter []byte
	if r == 5 {
		s := sha256.Sum256(u[32:40])
		check = s[:]
		s2 := sha256.Sum256(u[40:48])
		inter = s2[:]
	} else {
		check = hash2B(nil, u[32:40], nil)
		inter = hash2B(nil, u[40:48], nil)
	}
	if !bytes.Equal(check, u[:32]) {
		return nil, ErrPassword
	}
	block, err := aes.NewCipher(inter)
	if err != nil {
		return nil, err
	}
	key := make([]byte, 32)
	cipher.NewCBCDecrypter(block, make([]byte, 16)).CryptBlocks(key, ue[:32])
	return key, nil
}

// hash2B ISO 32000-2 算法 2.B
func hash2B(pw, salt, udata []byte) []byte {
	h := sha256.New()
	h.Write(pw)
	h.Write(salt)
	h.Write(udata)
	k := h.Sum(nil)
	for i := 0; ; i++ {
		k1 := make([]byte, 0, 64*(len(pw)+len(k)+len(udata)))
		for j := 0; j < 64; j++ {
			k1 = append(k1, pw...)
			k1 = append(k1, k...)
			k1 = append(k1, udata...)
		}
		block, _ := aes.NewCipher(k[:16])
		e := make([]byte, len(k1))
		cipher.NewCBCEncrypter(block, k[16:32]).CryptBlocks(e, k1)
		sum := 0
		for _, b := range e[:16] {
			sum += int(b)
		}
		var hh hash.Hash
		switch sum % 3 {
		case 0:
			hh = sha256.New()
		case 1:
			hh = sha512.New384()
		default:
			hh = sha512.New()
		}
		hh.Write(e)
		k = hh.Sum(nil)
		if i >= 63 && int(e[len(e)-1]) <= i-31 {
			break
		}
	}
	return k[:32]
}

func (c *decrypter) objKey(n, g int, aesSalt bool) []byte {
	if len(c.key) == 32 {
		return c.key // AES-256 直接用文件密钥
	}
	h := md5.New()
	h.Write(c.key)
	h.Write([]byte{byte(n), byte(n >> 8), byte(n >> 16), byte(g), byte(g >> 8)})
	if aesSalt {
		h.Write([]byte("sAlT"))
	}
	k := h.Sum(nil)
	l := len(c.key) + 5
	if l > 16 {
		l = 16
	}
	return k[:l]
}

func (c *decrypter) decrypt(m cryptMethod, data []byte, n, g int) []byte {
	switch m {
	case cmRC4:
		return rc4Bytes(c.objKey(n, g, false), data)
	case cmAESV2, cmAESV3:
		key := c.objKey(n, g, m == cmAESV2)
		if len(data) < 32 || len(data)%16 != 0 {
			if len(data) == 16 {
				return nil // 只有 IV 的空字符串
			}
			return data
		}
		block, err := aes.NewCipher(key)
		if err != nil {
			return data
		}
		out := make([]byte, len(data)-16)
		cipher.NewCBCDecrypter(block, data[:16]).CryptBlocks(out, data[16:])
		if p := int(out[len(out)-1]); p >= 1 && p <= 16 && p <= len(out) {
			out = out[:len(out)-p]
		}
		return out
	}
	return data
}

func (c *decrypter) decryptString(s []byte, n, g int) []byte {
	return c.decrypt(c.strM, s, n, g)
}

func (c *decrypter) decryptStream(data []byte, sd dict, n, g int) []byte {
	m := c.stmM
	// 流自己指定了加密过滤器（/Filter [/Crypt] /DecodeParms << /Name /Identity >>）
	if f, ok := sd["Filter"].(array); ok && len(f) > 0 && f[0] == name("Crypt") {
		m = cmNone
		if dp, ok := sd["DecodeParms"].(array); ok && len(dp) > 0 {
			if pd, ok := dp[0].(dict); ok {
				if nm, ok := pd["Name"].(name); ok {
					m = c.filters[string(nm)]
				}
			}
		}
	}
	return c.decrypt(m, data, n, g)
}
