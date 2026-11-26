//go:build windows

package screen

// DXGI 桌面复制（Desktop Duplication，Windows 8 起）：画面在显卡里，系统只在画面变化时给新的一帧，
// 并告诉我们哪些区域变了。比 GDI 的 BitBlt（每次都把整屏从显存读回内存，2560×1600 要 20～30 毫秒）快得多。
// Win7 没有这个接口（取 IDXGIOutput1 失败），推流时自动用 GDI。
//
// 接口方法序号对照 Windows SDK 的 dxgi.h、dxgi1_2.h、d3d11.h。

import (
	"errors"
	"fmt"
	"image"
	"runtime"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"p2d/core/internal/wincom"
)

var (
	dxgiDLL                 = syscall.NewLazyDLL("dxgi.dll")
	d3d11DLL                = syscall.NewLazyDLL("d3d11.dll")
	procCreateDXGIFactory1  = dxgiDLL.NewProc("CreateDXGIFactory1")
	procD3D11CreateDevice   = d3d11DLL.NewProc("D3D11CreateDevice")
	iidIDXGIFactory1        = wincom.GUID{D1: 0x770aae78, D2: 0xf26f, D3: 0x4dba, D4: [8]byte{0xa8, 0x29, 0x25, 0x3c, 0x83, 0xd1, 0xb3, 0x87}}
	iidIDXGIOutput1         = wincom.GUID{D1: 0x00cddea8, D2: 0x939b, D3: 0x4b83, D4: [8]byte{0xa3, 0x40, 0xa6, 0x85, 0x22, 0x66, 0x66, 0xcc}}
	iidID3D11Texture2D      = wincom.GUID{D1: 0x6f15aaf2, D2: 0xd208, D3: 0x4e89, D4: [8]byte{0x9a, 0xb4, 0x48, 0x95, 0x35, 0xd3, 0x4f, 0x9c}}
	errDuplicationLost      = ErrCaptureLost
	errDuplicationUnchanged = errors.New("画面没有变化")
	errNoDuplication        = errors.New("系统不支持桌面复制（需要 Windows 8 及以上）")
)

// 虚函数序号
const (
	factory1EnumAdapters1 = 12 // IDXGIFactory1
	adapterEnumOutputs    = 7  // IDXGIAdapter
	outputGetDesc         = 7  // IDXGIOutput
	output1DuplicateOut   = 22 // IDXGIOutput1
	duplAcquireNextFrame  = 8  // IDXGIOutputDuplication
	duplGetDirtyRects     = 9
	duplGetMoveRects      = 10
	duplReleaseFrame      = 14
	deviceCreateTexture2D = 5  // ID3D11Device
	ctxMap                = 14 // ID3D11DeviceContext
	ctxUnmap              = 15
	ctxCopySubresource    = 46
	ctxCopyResource       = 47
	tex2DGetDesc          = 10 // ID3D11Texture2D

	dxgiErrNotFound    = wincom.HRESULT(-0x7785FFFE) // 0x887A0002
	dxgiErrMoreData    = wincom.HRESULT(-0x7785FFFD) // 0x887A0003
	dxgiErrWaitTimeout = wincom.HRESULT(-0x7785FFD9) // 0x887A0027
	dxgiErrAccessLost  = wincom.HRESULT(-0x7785FFDA) // 0x887A0026

	d3d11SDKVersion       = 7
	d3dCreateBGRASupport  = 0x20
	d3dCreateVideoSupport = 0x800 // Win8 起；后面的硬件视频编码要用
	d3d11UsageStaging     = 3
	d3d11CPUAccessRead    = 0x20000
	d3d11MapRead          = 1
	dxgiFormatBGRA        = 87 // DXGI_FORMAT_B8G8R8A8_UNORM
	dxgiRotationIdentity  = 1
)

type dxgiOutputDesc struct {
	DeviceName [32]uint16
	Desktop    rect
	Attached   int32
	Rotation   uint32
	Monitor    uintptr
}

type dxgiFrameInfo struct {
	LastPresentTime     int64
	LastMouseUpdateTime int64
	AccumulatedFrames   uint32
	RectsCoalesced      int32
	ProtectedMaskedOut  int32
	PointerX, PointerY  int32
	PointerVisible      int32
	TotalMetadataSize   uint32
	PointerShapeSize    uint32
}

type tex2DDesc struct {
	Width, Height, MipLevels, ArraySize uint32
	Format                              uint32
	SampleCount, SampleQuality          uint32
	Usage, BindFlags, CPUAccess, Misc   uint32
}

type mappedSubresource struct {
	Data       unsafe.Pointer
	RowPitch   uint32
	DepthPitch uint32
}

type d3dBox struct{ Left, Top, Front, Right, Bottom, Back uint32 }

type moveRect struct {
	SrcX, SrcY int32
	Dst        rect
}

// dxgiCapturer 复制一个显示器的画面。只能在一个 goroutine 里用。
type dxgiCapturer struct {
	bounds  image.Rectangle // 显示器在虚拟桌面中的位置
	device  wincom.Obj      // ID3D11Device
	ctx     wincom.Obj      // ID3D11DeviceContext
	output  wincom.Obj      // IDXGIOutput1
	dupl    wincom.Obj      // IDXGIOutputDuplication
	staging wincom.Obj      // 可以被 CPU 读的纹理
	stageW  uint32
	stageH  uint32
	img     *image.RGBA // 当前画面（只更新变化的区域）
	meta    []byte
}

// openDXGI 为显示器 bounds 打开桌面复制。Win7、远程桌面会话、没有显卡驱动等情况会失败。
func openDXGI(bounds image.Rectangle) (*dxgiCapturer, error) {
	if procCreateDXGIFactory1.Find() != nil || procD3D11CreateDevice.Find() != nil {
		return nil, errNoDuplication
	}
	var factory wincom.Obj
	if hr := wincom.Proc(procCreateDXGIFactory1, uintptr(unsafe.Pointer(&iidIDXGIFactory1)), uintptr(unsafe.Pointer(&factory.P))); hr.Failed() {
		return nil, hr.Err("CreateDXGIFactory1")
	}
	defer factory.Release()

	c := &dxgiCapturer{bounds: bounds}
	var adapter, output wincom.Obj
	for ai := 0; adapter.Nil(); ai++ {
		a, hr := factory.Out(factory1EnumAdapters1, uintptr(ai))
		if hr == dxgiErrNotFound || hr.Failed() {
			break
		}
		for oi := 0; ; oi++ {
			o, hr := a.Out(adapterEnumOutputs, uintptr(oi))
			if hr.Failed() {
				break
			}
			var desc dxgiOutputDesc
			o.Call(outputGetDesc, uintptr(unsafe.Pointer(&desc)))
			r := image.Rect(int(desc.Desktop.Left), int(desc.Desktop.Top), int(desc.Desktop.Right), int(desc.Desktop.Bottom))
			if desc.Attached != 0 && r == bounds {
				if desc.Rotation > dxgiRotationIdentity {
					o.Release()
					a.Release()
					return nil, errors.New("显示器旋转了方向，桌面复制暂不支持")
				}
				adapter, output = a, o
				break
			}
			o.Release()
		}
		if adapter.Nil() {
			a.Release()
		}
	}
	if adapter.Nil() {
		return nil, fmt.Errorf("没有找到显示器 %v 对应的显卡输出", bounds)
	}
	defer adapter.Release()
	defer output.Release()

	// 在显示器所在的显卡上创建设备（双显卡笔记本上桌面复制只能在这块显卡上做）
	var fl uint32
	hr := wincom.Proc(procD3D11CreateDevice, adapter.Ptr(), 0, 0, d3dCreateBGRASupport|d3dCreateVideoSupport, 0, 0, d3d11SDKVersion,
		uintptr(unsafe.Pointer(&c.device.P)), uintptr(unsafe.Pointer(&fl)), uintptr(unsafe.Pointer(&c.ctx.P)))
	if hr.Failed() {
		hr = wincom.Proc(procD3D11CreateDevice, adapter.Ptr(), 0, 0, d3dCreateBGRASupport, 0, 0, d3d11SDKVersion,
			uintptr(unsafe.Pointer(&c.device.P)), uintptr(unsafe.Pointer(&fl)), uintptr(unsafe.Pointer(&c.ctx.P)))
	}
	if hr.Failed() {
		return nil, hr.Err("D3D11CreateDevice")
	}
	o1, err := output.QueryInterface(&iidIDXGIOutput1)
	if err != nil {
		c.Close()
		return nil, errNoDuplication
	}
	c.output = o1
	if err := c.duplicate(); err != nil {
		c.Close()
		return nil, err
	}
	return c, nil
}

func (c *dxgiCapturer) duplicate() error {
	c.dupl.Release()
	d, hr := c.output.Out(output1DuplicateOut, c.device.Ptr())
	if hr.Failed() {
		return hr.Err("DuplicateOutput")
	}
	c.dupl = d
	return nil
}

// hasImage 已经拿到过画面。刚开始复制时，画面不变就一直没有新帧，这期间要用别的方式截第一帧。
func (c *dxgiCapturer) hasImage() bool { return c.img != nil }

// Close 释放所有接口。
func (c *dxgiCapturer) Close() {
	c.staging.Release()
	c.dupl.Release()
	c.output.Release()
	c.ctx.Release()
	c.device.Release()
}

// next 等下一帧（最多等 wait）。画面没变时返回 errDuplicationUnchanged；复制中断时返回 errDuplicationLost。
// 返回的图片是内部缓冲区，下一次调用前有效。
func (c *dxgiCapturer) next(wait time.Duration) (*image.RGBA, error) {
	if c.dupl.Nil() {
		if err := c.duplicate(); err != nil {
			return nil, errDuplicationLost
		}
	}
	var info dxgiFrameInfo
	res, hr := c.dupl.Out(duplAcquireNextFrame, uintptr(wait/time.Millisecond), uintptr(unsafe.Pointer(&info)))
	switch {
	case hr == dxgiErrWaitTimeout:
		return nil, errDuplicationUnchanged
	case hr == dxgiErrAccessLost:
		c.dupl.Release()
		return nil, errDuplicationLost
	case hr.Failed():
		c.dupl.Release()
		return nil, hr.Err("AcquireNextFrame")
	}
	defer c.dupl.Call(duplReleaseFrame)
	defer res.Release()
	// 画面没有新内容：只有鼠标动了，或者刚开始复制时系统给的第一帧（是空的，全黑）
	if info.LastPresentTime == 0 {
		return nil, errDuplicationUnchanged
	}
	tex, err := res.QueryInterface(&iidID3D11Texture2D)
	if err != nil {
		return nil, err
	}
	defer tex.Release()
	var desc tex2DDesc
	tex.Call(tex2DGetDesc, uintptr(unsafe.Pointer(&desc)))
	if desc.Format != dxgiFormatBGRA {
		return nil, fmt.Errorf("桌面画面格式 %d 不是 BGRA", desc.Format)
	}
	if err := c.ensureStaging(desc); err != nil {
		return nil, err
	}
	w, h := int(desc.Width), int(desc.Height)
	full := c.img == nil || c.img.Bounds().Dx() != w || c.img.Bounds().Dy() != h
	if full {
		c.img = image.NewRGBA(image.Rect(0, 0, w, h))
	}
	var rects []image.Rectangle
	if !full {
		rects = c.changedRects(info.TotalMetadataSize, w, h)
		if rects == nil {
			full = true
		} else if len(rects) == 0 {
			return nil, errDuplicationUnchanged
		}
	}
	if full {
		c.ctx.Call(ctxCopyResource, c.staging.Ptr(), tex.Ptr())
		rects = []image.Rectangle{image.Rect(0, 0, w, h)}
	} else {
		for _, r := range rects {
			box := d3dBox{Left: uint32(r.Min.X), Top: uint32(r.Min.Y), Right: uint32(r.Max.X), Bottom: uint32(r.Max.Y), Back: 1}
			c.ctx.Call(ctxCopySubresource, c.staging.Ptr(), 0, uintptr(r.Min.X), uintptr(r.Min.Y), 0, tex.Ptr(), 0, uintptr(unsafe.Pointer(&box)))
		}
	}
	var m mappedSubresource
	if hr := c.ctx.Call(ctxMap, c.staging.Ptr(), 0, d3d11MapRead, 0, uintptr(unsafe.Pointer(&m))); hr.Failed() {
		return nil, hr.Err("Map")
	}
	src := unsafe.Slice((*byte)(m.Data), int(m.RowPitch)*(h-1)+w*4)
	for _, r := range rects {
		copyBGRA(c.img, src, int(m.RowPitch), r)
	}
	c.ctx.Call(ctxUnmap, c.staging.Ptr(), 0)
	return c.img, nil
}

// changedRects 这一帧变化的区域（移动区域的目标 + 脏区域）。取不到或区域太多时返回 nil（按整屏处理）。
func (c *dxgiCapturer) changedRects(size uint32, w, h int) []image.Rectangle {
	if size == 0 {
		return []image.Rectangle{}
	}
	if uint32(len(c.meta)) < size {
		c.meta = make([]byte, size)
	}
	var out []image.Rectangle
	bounds := image.Rect(0, 0, w, h)
	var used uint32
	if hr := c.dupl.Call(duplGetMoveRects, uintptr(size), uintptr(unsafe.Pointer(&c.meta[0])), uintptr(unsafe.Pointer(&used))); hr.Failed() {
		return nil
	}
	n := int(used / uint32(unsafe.Sizeof(moveRect{})))
	for i := 0; i < n; i++ {
		mr := (*moveRect)(unsafe.Pointer(&c.meta[i*int(unsafe.Sizeof(moveRect{}))]))
		out = append(out, image.Rect(int(mr.Dst.Left), int(mr.Dst.Top), int(mr.Dst.Right), int(mr.Dst.Bottom)).Intersect(bounds))
	}
	used = 0
	if hr := c.dupl.Call(duplGetDirtyRects, uintptr(size), uintptr(unsafe.Pointer(&c.meta[0])), uintptr(unsafe.Pointer(&used))); hr.Failed() {
		return nil
	}
	n = int(used / uint32(unsafe.Sizeof(rect{})))
	for i := 0; i < n; i++ {
		r := (*rect)(unsafe.Pointer(&c.meta[i*int(unsafe.Sizeof(rect{}))]))
		out = append(out, image.Rect(int(r.Left), int(r.Top), int(r.Right), int(r.Bottom)).Intersect(bounds))
	}
	if len(out) > 64 {
		return nil
	}
	rs := out[:0]
	for _, r := range out {
		if !r.Empty() {
			rs = append(rs, r)
		}
	}
	return rs
}

func (c *dxgiCapturer) ensureStaging(d tex2DDesc) error {
	if !c.staging.Nil() && c.stageW == d.Width && c.stageH == d.Height {
		return nil
	}
	c.staging.Release()
	sd := tex2DDesc{Width: d.Width, Height: d.Height, MipLevels: 1, ArraySize: 1, Format: d.Format, SampleCount: 1,
		Usage: d3d11UsageStaging, CPUAccess: d3d11CPUAccessRead}
	t, hr := c.device.Out(deviceCreateTexture2D, uintptr(unsafe.Pointer(&sd)), 0)
	if hr.Failed() {
		return hr.Err("CreateTexture2D")
	}
	c.staging, c.stageW, c.stageH = t, d.Width, d.Height
	return nil
}

// copyBGRA 把 src（BGRA，每行 pitch 字节）里 r 区域转成 RGBA 写进 dst。大区域按行分给多个核。
func copyBGRA(dst *image.RGBA, src []byte, pitch int, r image.Rectangle) {
	rows := func(y0, y1 int) {
		for y := y0; y < y1; y++ {
			s := src[y*pitch+r.Min.X*4 : y*pitch+r.Max.X*4]
			d := dst.Pix[y*dst.Stride+r.Min.X*4 : y*dst.Stride+r.Max.X*4]
			for i := 0; i+3 < len(s); i += 4 {
				d[i], d[i+1], d[i+2], d[i+3] = s[i+2], s[i+1], s[i], 255
			}
		}
	}
	workers := runtime.NumCPU()
	if workers > 8 {
		workers = 8
	}
	if r.Dx()*r.Dy() < 256*256 || workers < 2 {
		rows(r.Min.Y, r.Max.Y)
		return
	}
	var wg sync.WaitGroup
	h := r.Dy()
	for i := 0; i < workers; i++ {
		y0, y1 := r.Min.Y+h*i/workers, r.Min.Y+h*(i+1)/workers
		wg.Add(1)
		go func() {
			defer wg.Done()
			rows(y0, y1)
		}()
	}
	wg.Wait()
}
