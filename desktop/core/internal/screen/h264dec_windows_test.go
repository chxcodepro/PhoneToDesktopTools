//go:build windows

package screen

import (
	"errors"
	"image"
	"image/color"
	"syscall"
	"unsafe"

	"p2d/core/internal/wincom"
)

// 测试用：用 Windows 自带的软件 H.264 解码器（CLSID_CMSH264DecoderMFT，同步 MFT）把码流解回图片，检查编码结果对不对。

var (
	procCoCreateInstance = ole32DLL.NewProc("CoCreateInstance")
	clsidMSH264Decoder   = guid(0x62ce7e72, 0x4c71, 0x4d20, 0xb1, 0x5d, 0x45, 0x28, 0x31, 0xa8, 0x7d, 0x9d)
)

type h264Decoder struct {
	mft  wincom.Obj
	si   mftOutputStreamInfo
	w, h int
}

func newH264Decoder() (*h264Decoder, error) {
	d := &h264Decoder{}
	if hr := wincom.Proc(procCoCreateInstance, uintptr(unsafe.Pointer(&clsidMSH264Decoder)), 0, 1,
		uintptr(unsafe.Pointer(&iidIMFTransform)), uintptr(unsafe.Pointer(&d.mft.P))); hr.Failed() {
		return nil, hr.Err("创建 H.264 解码器")
	}
	var mt wincom.Obj
	wincom.Proc(procMFCreateMediaType, uintptr(unsafe.Pointer(&mt.P)))
	mt.Call(attrSetGUID, uintptr(unsafe.Pointer(&mfMTMajorType)), uintptr(unsafe.Pointer(&mfMediaTypeVideo)))
	mt.Call(attrSetGUID, uintptr(unsafe.Pointer(&mfMTSubtype)), uintptr(unsafe.Pointer(&mfVideoFormatH264)))
	hr := d.mft.Call(mftSetInputType, 0, mt.Ptr(), 0)
	mt.Release()
	if hr.Failed() {
		return nil, hr.Err("解码器输入格式")
	}
	return d, d.pickOutput()
}

func (d *h264Decoder) pickOutput() error {
	for i := 0; ; i++ {
		mt, hr := d.mft.Out(mftGetOutputAvailType, 0, uintptr(i))
		if hr.Failed() {
			return errors.New("解码器没有 NV12 输出")
		}
		var sub wincom.GUID
		mt.Call(10, uintptr(unsafe.Pointer(&mfMTSubtype)), uintptr(unsafe.Pointer(&sub))) // GetGUID
		if sub == mfVideoFormatNV12 {
			var size uint64
			mt.Call(8, uintptr(unsafe.Pointer(&mfMTFrameSize)), uintptr(unsafe.Pointer(&size))) // GetUINT64
			d.w, d.h = int(size>>32), int(uint32(size))
			hr = d.mft.Call(mftSetOutputType, 0, mt.Ptr(), 0)
			mt.Release()
			d.mft.Call(mftGetOutputStreamInfo, 0, uintptr(unsafe.Pointer(&d.si)))
			return hr.Err("解码器输出格式")
		}
		mt.Release()
	}
}

// decode 送进一帧，返回解出来的最新一张图（没有就返回 nil）。
func (d *h264Decoder) decode(data []byte) (*image.RGBA, error) {
	var buf, s wincom.Obj
	wincom.Proc(procMFCreateMemoryBuffer, uintptr(len(data)), uintptr(unsafe.Pointer(&buf.P)))
	var p *byte
	var maxLen, cur uint32
	buf.Call(bufferLock, uintptr(unsafe.Pointer(&p)), uintptr(unsafe.Pointer(&maxLen)), uintptr(unsafe.Pointer(&cur)))
	copy(unsafe.Slice(p, len(data)), data)
	buf.Call(bufferUnlock)
	buf.Call(bufferSetCurrentLength, uintptr(len(data)))
	wincom.Proc(procMFCreateSample, uintptr(unsafe.Pointer(&s.P)))
	s.Call(sampleAddBuffer, buf.Ptr())
	hr := d.mft.Call(mftProcessInput, 0, s.Ptr(), 0)
	s.Release()
	buf.Release()
	if hr.Failed() {
		return nil, hr.Err("解码 ProcessInput")
	}
	var last *image.RGBA
	for {
		var own, mem wincom.Obj
		wincom.Proc(procMFCreateSample, uintptr(unsafe.Pointer(&own.P)))
		wincom.Proc(procMFCreateMemoryBuffer, uintptr(d.si.Size), uintptr(unsafe.Pointer(&mem.P)))
		own.Call(sampleAddBuffer, mem.Ptr())
		out := &mftOutputDataBuffer{Sample: own.P}
		var status uint32
		hr := d.mft.Call(mftProcessOutput, 0, 1, uintptr(unsafe.Pointer(out)), uintptr(unsafe.Pointer(&status)))
		if hr == mfETransformStreamChange {
			own.Release()
			mem.Release()
			if err := d.pickOutput(); err != nil {
				return nil, err
			}
			continue
		}
		if hr.Failed() {
			own.Release()
			mem.Release()
			if hr == mfETransformNeedInput {
				return last, nil
			}
			return nil, hr.Err("解码 ProcessOutput")
		}
		mem.Call(bufferLock, uintptr(unsafe.Pointer(&p)), uintptr(unsafe.Pointer(&maxLen)), uintptr(unsafe.Pointer(&cur)))
		last = nv12ToRGBA(unsafe.Slice(p, cur), d.w, d.h)
		mem.Call(bufferUnlock)
		own.Release()
		mem.Release()
	}
}

// nv12ToRGBA BT.709、16～235 的 NV12 转 RGBA。缓冲区高度可能按 16 对齐，从长度推算 UV 平面的位置。
func nv12ToRGBA(b []byte, w, h int) *image.RGBA {
	ah := len(b) * 2 / 3 / w
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			Y := float64(b[y*w+x]) - 16
			uv := ah*w + (y/2)*w + (x/2)*2
			U, V := float64(b[uv])-128, float64(b[uv+1])-128
			r := 1.164*Y + 1.793*V
			g := 1.164*Y - 0.213*U - 0.533*V
			bb := 1.164*Y + 2.112*U
			img.SetRGBA(x, y, color.RGBA{clamp(r), clamp(g), clamp(bb), 255})
		}
	}
	return img
}

func clamp(v float64) uint8 {
	if v < 0 {
		return 0
	}
	if v > 255 {
		return 255
	}
	return uint8(v + 0.5)
}

var _ = syscall.Errno(0)
