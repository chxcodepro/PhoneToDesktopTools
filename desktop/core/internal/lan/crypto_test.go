package lan

import (
	"bytes"
	"encoding/hex"
	"testing"
)

// 固定输入的结果，手机端 tests/secure.test.ts 用同样的数值校验，保证两端实现一致。
func TestVectors(t *testing.T) {
	k := bytes.Repeat([]byte{0x11}, 32)
	nc := bytes.Repeat([]byte{0x22}, 16)
	ns := bytes.Repeat([]byte{0x33}, 16)
	c2s, s2c := SessionKeys(k, nc, ns)
	c, _ := NewCipher(c2s)
	frame := c.Seal(FrameText, []byte(`{"a":1}`))
	frame1 := c.Seal(FrameText, []byte("你好"))
	tr := Transcript([]byte("PUBPHONE"), []byte("PUBPC"), "phone-1", "pc-1")
	want := map[string]string{
		"c2s":        "bb384ad708167679f9cf608764bd5c5b417acbe2d8174d085b47ab1b9811bfc8",
		"s2c":        "e4cb9a4169fbdff52368f13be2a01e79af563047f3975ecda19ebd2d831f1210",
		"frame0":     "9eef98253b91207d9c6291e11a19e38c1d216345a82b296e",
		"frame1":     "4f16ffd19c55f5bdd36ecd8d594357ba65b090d748fb3d",
		"transcript": "21ee8fd8e658512f1b68c8c4deeca8359e9b224f169066d11f60d52b8fae5dde",
	}
	got := map[string]string{
		"c2s": hex.EncodeToString(c2s), "s2c": hex.EncodeToString(s2c),
		"frame0": hex.EncodeToString(frame), "frame1": hex.EncodeToString(frame1), "transcript": hex.EncodeToString(tr),
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s = %s，应为 %s", k, got[k], v)
		}
	}
	if sas := SAS(bytes.Repeat([]byte{0x44}, 32), tr); sas != "088755" {
		t.Errorf("sas = %s", sas)
	}

	d, _ := NewCipher(c2s)
	typ, pt, err := d.Open(frame)
	if err != nil || typ != FrameText || string(pt) != `{"a":1}` {
		t.Fatalf("解密失败：%v %d %q", err, typ, pt)
	}
	// 计数器不同步（重放 / 乱序）必须失败
	if _, _, err := d.Open(frame); err == nil {
		t.Fatal("重放的帧不应解密成功")
	}
	// 篡改
	e, _ := NewCipher(c2s)
	bad := append([]byte{}, frame...)
	bad[3] ^= 1
	if _, _, err := e.Open(bad); err == nil {
		t.Fatal("篡改的帧不应解密成功")
	}
}

func TestPairingWindow(t *testing.T) {
	w := NewPairingWindow(nil)
	if _, err := w.Begin(); err != ErrNotOpen {
		t.Fatal("未打开时应拒绝")
	}
	w.Start(60e9)
	s1, err := w.Begin()
	if err != nil || len(s1) != 16 {
		t.Fatal(err)
	}
	if _, err := w.Begin(); err != ErrBusy {
		t.Fatal("同时只能配一台")
	}
	w.Finish(false, "")
	if _, err := w.Begin(); err != nil {
		t.Fatal("失败后应能重试")
	}
	w.Finish(true, "小米")
	if info := w.Info(); info.Active || info.State != "done" || info.PhoneName != "小米" {
		t.Fatalf("成功后应关闭窗口：%+v", info)
	}
	if _, err := w.Begin(); err != ErrNotOpen {
		t.Fatal("成功后不应再接受")
	}
}

func TestStore(t *testing.T) {
	dir := t.TempDir()
	s := OpenStore(dir)
	id := s.PCID()
	s.Add("p1", "手机", bytes.Repeat([]byte{1}, 32))
	s2 := OpenStore(dir)
	if s2.PCID() != id {
		t.Fatal("电脑标识应保持不变")
	}
	if k, name, ok := s2.Key("p1"); !ok || name != "手机" || len(k) != 32 {
		t.Fatal("配对记录应能恢复")
	}
	s2.Remove("p1")
	if _, _, ok := OpenStore(dir).Key("p1"); ok {
		t.Fatal("取消配对后应删除")
	}
}

// AES-GCM（手机端在握手时要求时用）：和手机端 tests/secure.test.ts 的固定结果一致
func TestAESGCMVectors(t *testing.T) {
	k := bytes.Repeat([]byte{0x11}, 32)
	c2s, _ := SessionKeys(k, bytes.Repeat([]byte{0x22}, 16), bytes.Repeat([]byte{0x33}, 16))
	c, err := NewCipherFor(CipherAESGCM, c2s)
	if err != nil {
		t.Fatal(err)
	}
	f0 := hex.EncodeToString(c.Seal(FrameText, []byte(`{"a":1}`)))
	f1 := hex.EncodeToString(c.Seal(FrameText, []byte("你好")))
	if f0 != "da0855921bcf83e8488fef21e436ddcc0ffba85ca8aba1f3" || f1 != "6937f98f4fedd015e34f87d12fbd08751d091a7e0243db" {
		t.Fatalf("aes frame0=%s frame1=%s", f0, f1)
	}
	rd, _ := NewCipherFor(CipherAESGCM, c2s)
	w, _ := hex.DecodeString(f0)
	if typ, p, err := rd.Open(w); err != nil || typ != FrameText || string(p) != `{"a":1}` {
		t.Fatalf("解不开：%v", err)
	}
	if f0 == "9eef98253b91207d9c6291e11a19e38c1d216345a82b296e" {
		t.Fatal("AES 和 ChaCha20 的结果不应相同")
	}
}
