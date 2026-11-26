package server

import (
	"encoding/binary"
	"encoding/json"
	"testing"

	"p2d/core/internal/screen"
)

func TestVideoSize(t *testing.T) {
	d := screen.Display{Width: 2560, Height: 1600}
	cases := []struct {
		maxW int
		req  videoRequest
		w, h int
	}{
		{2376, videoRequest{MaxWidth: 4096, MaxHeight: 2304}, 2376, 1484}, // 按手机要的宽度，宽高都是偶数
		{3840, videoRequest{MaxWidth: 1920, MaxHeight: 1080}, 1728, 1080}, // 解码器高度上限更紧
		{0, videoRequest{}, 2560, 1600},                                   // 不放大
	}
	for _, c := range cases {
		w, h := videoSize(d, c.maxW, &c.req)
		if w != c.w || h != c.h {
			t.Errorf("maxW=%d req=%+v：得到 %dx%d，应为 %dx%d", c.maxW, c.req, w, h, c.w, c.h)
		}
	}
}

func TestVideoMessage(t *testing.T) {
	b := videoMessage(videoMeta{Seq: 7, Key: true, Width: 100, Height: 50}, []byte{0, 0, 0, 1, 0x65})
	if string(b[:4]) != videoMagic {
		t.Fatal("开头不是 P2DV")
	}
	n := binary.LittleEndian.Uint32(b[4:])
	var m videoMeta
	if err := json.Unmarshal(b[8:8+n], &m); err != nil || m.Seq != 7 || !m.Key || m.Width != 100 {
		t.Fatalf("元数据不对：%v %+v", err, m)
	}
	if string(b[8+n:]) != string([]byte{0, 0, 0, 1, 0x65}) {
		t.Fatal("视频数据不对")
	}
}
