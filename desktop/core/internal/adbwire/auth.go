package adbwire

// 电脑端的 ADB 密钥：手机上点「允许 USB 调试」（勾选「一律允许」）后，手机记住这把密钥的公钥，以后连接时电脑用私钥签名通过验证。
// 和 adb 用同一把密钥（用户目录下的 .android/adbkey）：以前电脑端带的 adb 生成过它，已经授权过的手机不用再点一次允许；
// 没有时生成一把放在那里（和 adb 的做法相同），那里写不进去就放在电脑端的数据目录。

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/binary"
	"encoding/pem"
	"errors"
	"fmt"
	"log"
	"math/big"
	"os"
	"path/filepath"
	"sync"
)

const keyBits = 2048

// Keys 电脑端的 ADB 密钥，第一次用到时才读取或生成（生成要零点几秒）
type Keys struct {
	stateDir string
	comment  string // 公钥后面的说明，手机上的授权列表里显示，如 P2D@电脑名

	once sync.Once
	key  *rsa.PrivateKey
	err  error
}

// NewKeys stateDir 是电脑端的数据目录（.android 写不进去时用），name 是电脑名
func NewKeys(stateDir, name string) *Keys {
	if name == "" {
		name = "pc"
	}
	return &Keys{stateDir: stateDir, comment: "P2D@" + name}
}

// androidDir adb 存放密钥的目录：ANDROID_USER_HOME，或用户目录下的 .android
func androidDir() string {
	if d := os.Getenv("ANDROID_USER_HOME"); d != "" {
		return d
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".android")
}

func (k *Keys) load() {
	var paths []string
	if d := androidDir(); d != "" {
		paths = append(paths, filepath.Join(d, "adbkey"))
	}
	if k.stateDir != "" {
		paths = append(paths, filepath.Join(k.stateDir, "adbkey"))
	}
	for _, p := range paths {
		key, err := readKey(p)
		if err == nil {
			k.key = key
			return
		}
		if !errors.Is(err, os.ErrNotExist) {
			log.Printf("ADB 密钥 %s 不能用：%v", p, err)
		}
	}
	key, err := rsa.GenerateKey(rand.Reader, keyBits)
	if err != nil {
		k.err = fmt.Errorf("生成 ADB 密钥失败：%w", err)
		return
	}
	k.key = key
	for _, p := range paths {
		if err := writeKey(p, key, k.comment); err != nil {
			log.Printf("保存 ADB 密钥到 %s 失败：%v", p, err)
			continue
		}
		log.Printf("已生成 ADB 密钥：%s", p)
		return
	}
	log.Printf("ADB 密钥没有保存下来，下次启动后手机要重新允许 USB 调试")
}

func readKey(path string) (*rsa.PrivateKey, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	blk, _ := pem.Decode(b)
	if blk == nil {
		return nil, errors.New("不是 PEM 格式")
	}
	var key *rsa.PrivateKey
	if k, err := x509.ParsePKCS8PrivateKey(blk.Bytes); err == nil {
		rk, ok := k.(*rsa.PrivateKey)
		if !ok {
			return nil, errors.New("不是 RSA 密钥")
		}
		key = rk
	} else if key, err = x509.ParsePKCS1PrivateKey(blk.Bytes); err != nil {
		return nil, err
	}
	if key.N.BitLen() != keyBits {
		return nil, fmt.Errorf("密钥长度是 %d 位，adb 要求 %d 位", key.N.BitLen(), keyBits)
	}
	return key, nil
}

func writeKey(path string, key *rsa.PrivateKey, comment string) error {
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	if _, err := os.Stat(path); err == nil {
		return os.ErrExist // 不覆盖（读不了的密钥文件可能是用户自己的）
	}
	if err := os.WriteFile(path, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}), 0o600); err != nil {
		return err
	}
	pub := base64.StdEncoding.EncodeToString(encodePublicKey(&key.PublicKey)) + " " + comment + "\n"
	_ = os.WriteFile(path+".pub", []byte(pub), 0o644)
	return nil
}

func (k *Keys) get() (*rsa.PrivateKey, error) {
	k.once.Do(k.load)
	return k.key, k.err
}

// sign 用私钥签手机发来的 20 字节随机数（adb 的做法：当作 SHA-1 摘要做 PKCS#1 v1.5 签名）
func (k *Keys) sign(token []byte) ([]byte, error) {
	key, err := k.get()
	if err != nil {
		return nil, err
	}
	if len(token) != 20 {
		return nil, fmt.Errorf("手机发来的随机数长度 %d 不对", len(token))
	}
	return rsa.SignPKCS1v15(nil, key, crypto.SHA1, token)
}

// publicKey 发给手机的公钥：base64 编码的 Android 格式公钥 + 空格 + 说明 + \0
func (k *Keys) publicKey() ([]byte, error) {
	key, err := k.get()
	if err != nil {
		return nil, err
	}
	s := base64.StdEncoding.EncodeToString(encodePublicKey(&key.PublicKey)) + " " + k.comment
	return append([]byte(s), 0), nil
}

// encodePublicKey Android 的 RSAPublicKey 结构（libcrypto_utils 的 android_pubkey）：
// 模数的字数、-1/n[0] mod 2^32、模数（小端字序）、R^2 mod n（R = 2^2048，小端字序）、公钥指数，全部小端 uint32
func encodePublicKey(pub *rsa.PublicKey) []byte {
	const words = keyBits / 32
	r32 := new(big.Int).Lsh(big.NewInt(1), 32)
	n0 := new(big.Int).Mod(pub.N, r32)
	n0inv := new(big.Int).ModInverse(n0, r32)
	n0inv.Sub(r32, n0inv)
	rr := new(big.Int).Lsh(big.NewInt(1), keyBits*2)
	rr.Mod(rr, pub.N)

	buf := make([]byte, 4+4+words*4+words*4+4)
	binary.LittleEndian.PutUint32(buf[0:], words)
	binary.LittleEndian.PutUint32(buf[4:], uint32(n0inv.Uint64()))
	putWords(buf[8:8+words*4], pub.N)
	putWords(buf[8+words*4:8+words*8], rr)
	binary.LittleEndian.PutUint32(buf[8+words*8:], uint32(pub.E))
	return buf
}

// putWords 把大整数按小端字节序写满 dst（dst 的长度是 4 的倍数，低位字在前，每个字也是小端，合起来就是整个数的小端表示）
func putWords(dst []byte, v *big.Int) {
	be := v.FillBytes(make([]byte, len(dst)))
	for i := range be {
		dst[i] = be[len(be)-1-i]
	}
}
