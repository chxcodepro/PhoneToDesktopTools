package screen

import "errors"

// ErrCaptureLost 桌面复制暂时中断（锁屏、UAC 安全桌面、切换分辨率），稍后重试就行。
var ErrCaptureLost = errors.New("桌面复制中断（切换了桌面、分辨率或进入了安全桌面）")

// VideoConfig 硬件视频流的参数。
type VideoConfig struct {
	Width, Height int // 输出画面尺寸（偶数）
	FPS           int
	Bitrate       int // 平均码率，比特/秒
}

// VideoFrame 编码好的一帧 H.264（Annex B 格式，NAL 前面带 00 00 00 01 起始码）。
type VideoFrame struct {
	Data []byte
	Key  bool // 关键帧（IDR），解码器从这里开始就能解
}

// VideoSize 按最大宽度（长边）算视频输出尺寸：不放大、保持比例、宽高都是偶数（H.264 要求），最大 4096。
func VideoSize(w, h, maxWidth int) (int, int) {
	if maxWidth <= 0 || maxWidth > 4096 {
		maxWidth = 4096
	}
	ow, oh := w, h
	if ow > maxWidth {
		ow = maxWidth
		oh = int(float64(h)*float64(maxWidth)/float64(w) + 0.5)
	}
	if oh > 4096 {
		ow = int(float64(ow)*4096/float64(oh) + 0.5)
		oh = 4096
	}
	return ow &^ 1, oh &^ 1
}

// hasNAL Annex B 数据里有没有某种 NAL（5 = IDR 关键帧，7 = SPS，8 = PPS）。
func hasNAL(b []byte, typ byte) bool {
	for i := 0; i+3 < len(b); i++ {
		if b[i] == 0 && b[i+1] == 0 && b[i+2] == 1 && b[i+3]&0x1f == typ {
			return true
		}
	}
	return false
}
