//go:build windows

package screen

// 硬件 H.264 视频流（Windows 8 起）：桌面复制拿到的画面一直留在显卡里，
// 用 D3D11 视频处理器缩放并转成 NV12，交给显卡的硬件编码器（Media Foundation 的硬件 MFT：
// NVIDIA NVENC、Intel Quick Sync、AMD VCE/VCN），输出 H.264。没有硬件编码器时打开失败，推流退回 JPEG 分块。
//
// 硬件编码器是异步的：它发 METransformNeedInput 事件要输入，发 METransformHaveOutput 事件表示有输出。
// 这里用不等待的方式轮询事件（Poll），由调用方决定什么时候喂新画面（Feed），全部在同一个 goroutine 里调用。
// 接口方法序号和 GUID 对照 mingw-w64 / Wine 的 d3d11.idl、mfobjects.idl、mftransform.idl、mfapi.h、codecapi.h、strmif.idl。

import (
	"errors"
	"fmt"
	"runtime"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"p2d/core/internal/wincom"
)

var (
	mfplatDLL                     = syscall.NewLazyDLL("mfplat.dll")
	ole32DLL                      = syscall.NewLazyDLL("ole32.dll")
	procMFStartup                 = mfplatDLL.NewProc("MFStartup")
	procMFCreateMediaType         = mfplatDLL.NewProc("MFCreateMediaType")
	procMFCreateSample            = mfplatDLL.NewProc("MFCreateSample")
	procMFCreateMemoryBuffer      = mfplatDLL.NewProc("MFCreateMemoryBuffer")
	procMFCreateDXGISurfaceBuffer = mfplatDLL.NewProc("MFCreateDXGISurfaceBuffer") // Win8 起
	procMFCreateDXGIDeviceManager = mfplatDLL.NewProc("MFCreateDXGIDeviceManager") // Win8 起
	procMFTEnumEx                 = mfplatDLL.NewProc("MFTEnumEx")
	procCoInitializeEx            = ole32DLL.NewProc("CoInitializeEx")
	procCoUninitialize            = ole32DLL.NewProc("CoUninitialize")
	procCoTaskMemFree             = ole32DLL.NewProc("CoTaskMemFree")

	mfStartOnce sync.Once
	mfStartErr  error
)

func guid(d1 uint32, d2, d3 uint16, d4 ...byte) wincom.GUID {
	g := wincom.GUID{D1: d1, D2: d2, D3: d3}
	copy(g.D4[:], d4)
	return g
}

var (
	mftCategoryVideoEncoder = guid(0xf79eac7d, 0xe545, 0x4387, 0xbd, 0xee, 0xd6, 0x47, 0xd7, 0xbd, 0xe4, 0x2a)
	mfMediaTypeVideo        = guid(0x73646976, 0x0000, 0x0010, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71)
	mfVideoFormatH264       = guid(0x34363248, 0x0000, 0x0010, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71) // FCC('H264')
	mfVideoFormatNV12       = guid(0x3231564e, 0x0000, 0x0010, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71) // FCC('NV12')
	mfMTMajorType           = guid(0x48eba18e, 0xf8c9, 0x4687, 0xbf, 0x11, 0x0a, 0x74, 0xc9, 0xf9, 0x6a, 0x8f)
	mfMTSubtype             = guid(0xf7e34c9a, 0x42e8, 0x4714, 0xb7, 0x4b, 0xcb, 0x29, 0xd7, 0x2c, 0x35, 0xe5)
	mfMTFrameSize           = guid(0x1652c33d, 0xd6b2, 0x4012, 0xb8, 0x34, 0x72, 0x03, 0x08, 0x49, 0xa3, 0x7d)
	mfMTFrameRate           = guid(0xc459a2e8, 0x3d2c, 0x4e44, 0xb1, 0x32, 0xfe, 0xe5, 0x15, 0x6c, 0x7b, 0xb0)
	mfMTAvgBitrate          = guid(0x20332624, 0xfb0d, 0x4d9e, 0xbd, 0x0d, 0xcb, 0xf6, 0x78, 0x6c, 0x10, 0x2e)
	mfMTInterlaceMode       = guid(0xe2724bb8, 0xe676, 0x4806, 0xb4, 0xb2, 0xa8, 0xd6, 0xef, 0xb4, 0x4c, 0xcd)
	mfMTPixelAspectRatio    = guid(0xc6376a1e, 0x8d0a, 0x4027, 0xbe, 0x45, 0x6d, 0x9a, 0x0a, 0xd3, 0x9b, 0xb6)
	mfMTMpeg2Profile        = guid(0xad76a80b, 0x2d5c, 0x4e0b, 0xb3, 0x75, 0x64, 0xe5, 0x20, 0x13, 0x70, 0x36)
	mfMTMpegSequenceHeader  = guid(0x3c036de7, 0x3ad0, 0x4c9e, 0x92, 0x16, 0xee, 0x6d, 0x6a, 0xc2, 0x1c, 0xb3)
	mfMTYUVMatrix           = guid(0x3e23d450, 0x2c75, 0x4d25, 0xa0, 0x0e, 0xb9, 0x16, 0x70, 0xd1, 0x23, 0x27)
	mfMTNominalRange        = guid(0xc21b8ee5, 0xb956, 0x4071, 0x8d, 0xaf, 0x32, 0x5e, 0xdf, 0x5c, 0xab, 0x11)
	mfTransformAsyncUnlock  = guid(0xe5666d6b, 0x3422, 0x4eb6, 0xa4, 0x21, 0xda, 0x7d, 0xb1, 0xf8, 0xe2, 0x07)
	mftFriendlyName         = guid(0x314ffbae, 0x5b41, 0x4c95, 0x9c, 0x19, 0x4e, 0x7d, 0x58, 0x6f, 0xac, 0xe3)
	codecLowLatency         = guid(0x9c27891a, 0xed7a, 0x40e1, 0x88, 0xe8, 0xb2, 0x27, 0x27, 0xa0, 0x24, 0xee)
	codecRateControl        = guid(0x1c0608e9, 0x370c, 0x4710, 0x8a, 0x58, 0xcb, 0x61, 0x81, 0xc4, 0x24, 0x23)
	codecMeanBitRate        = guid(0xf7222374, 0x2144, 0x4815, 0xb5, 0x50, 0xa3, 0x7f, 0x8e, 0x12, 0xee, 0x52)
	codecGOPSize            = guid(0x95f31b26, 0x95a4, 0x41aa, 0x93, 0x03, 0x24, 0x6a, 0x7f, 0xc6, 0xee, 0xf1)
	codecForceKeyFrame      = guid(0x398c1b98, 0x8353, 0x475a, 0x9e, 0xf2, 0x8f, 0x26, 0x5d, 0x26, 0x03, 0x45)
	codecBPictureCount      = guid(0x8d390aac, 0xdc5c, 0x4200, 0xb5, 0x7f, 0x81, 0x4d, 0x04, 0xba, 0xba, 0xb2)
	iidIMFTransform         = guid(0xbf94c121, 0x5b05, 0x4e6f, 0x80, 0x00, 0xba, 0x59, 0x89, 0x61, 0x41, 0x4d)
	iidICodecAPI            = guid(0x901db4c7, 0x31ce, 0x41a2, 0x85, 0xdc, 0x8f, 0xa0, 0xbf, 0x41, 0xb8, 0xda)
	iidIMFEventGenerator    = guid(0x2cd0bd52, 0xbcd5, 0x4b89, 0xb6, 0x2c, 0xea, 0xdc, 0x0c, 0x03, 0x1e, 0x7d)
	iidID3D11VideoDevice    = guid(0x10ec4d5b, 0x975a, 0x4689, 0xb9, 0xe4, 0xd0, 0xaa, 0xc3, 0x0f, 0xe3, 0x33)
	iidID3D11VideoContext   = guid(0x61f21c45, 0x3c0e, 0x4a74, 0x9c, 0xea, 0x67, 0x10, 0x0d, 0x9a, 0xd5, 0xe4)
	iidID3D10Multithread    = guid(0x9b7e4e00, 0x342c, 0x4106, 0xa1, 0x9f, 0x4f, 0x27, 0x04, 0xf6, 0x89, 0xf0)

	mfENoEventsAvailable     = hres(0xc00d3e80)
	mfENotAccepting          = hres(0xc00d36b5)
	mfETransformStreamChange = hres(0xc00d6d61)
	mfETransformNeedInput    = hres(0xc00d6d72)
)

func hres(v uint32) wincom.HRESULT { return wincom.HRESULT(int32(v)) }

// 虚函数序号
const (
	attrGetUINT32           = 7 // IMFAttributes（IMFMediaType、IMFSample、IMFActivate、IMFMediaEvent 都继承它）
	attrGetAllocatedString  = 13
	attrGetBlobSize         = 14
	attrGetBlob             = 15
	attrSetUINT32           = 21
	attrSetUINT64           = 22
	attrSetGUID             = 24
	activateActivateObject  = 33 // IMFActivate
	activateShutdownObject  = 34
	eventGetType            = 33 // IMFMediaEvent
	sampleSetTime           = 36 // IMFSample
	sampleSetDuration       = 38
	sampleToContiguous      = 41
	sampleAddBuffer         = 42
	bufferLock              = 3 // IMFMediaBuffer
	bufferUnlock            = 4
	bufferSetCurrentLength  = 6
	genGetEvent             = 3 // IMFMediaEventGenerator
	devMgrResetDevice       = 7 // IMFDXGIDeviceManager
	codecSetValue           = 9 // ICodecAPI
	mtSetProtected          = 5 // ID3D10Multithread
	mftGetOutputStreamInfo  = 7 // IMFTransform
	mftGetAttributes        = 8
	mftGetOutputAvailType   = 14
	mftSetInputType         = 15
	mftSetOutputType        = 16
	mftGetOutputCurrentType = 18
	mftProcessMessage       = 23
	mftProcessInput         = 24
	mftProcessOutput        = 25
	vdevCreateProcessor     = 4 // ID3D11VideoDevice
	vdevCreateInputView     = 8
	vdevCreateOutputView    = 9
	vdevCreateEnumerator    = 10
	vctxSetOutputColorSpace = 15 // ID3D11VideoContext
	vctxSetStreamColorSpace = 28
	vctxSetStreamAutoProc   = 37
	vctxBlt                 = 53
	ctxUpdateSubresource    = 48 // ID3D11DeviceContext

	meTransformNeedInput  = 601
	meTransformHaveOutput = 602

	mftMsgCommandFlush     = 0
	mftMsgSetD3DManager    = 2
	mftMsgBeginStreaming   = 0x10000000
	mftMsgEndStreaming     = 0x10000001
	mftMsgEndOfStream      = 0x10000002
	mftMsgStartOfStream    = 0x10000003
	mftProvidesSamples     = 0x100
	mftEnumFlagHardware    = 0x4
	mftEnumFlagSortFilter  = 0x40
	mfVersion              = 0x20070
	mfEventFlagNoWait      = 1
	vtUI4                  = 19
	vtBool                 = 11
	dxgiFormatNV12         = 103
	dxgiFormatRGBA         = 28
	d3d11BindShaderRes     = 0x8
	d3d11BindRenderTarget  = 0x20
	d3d11BindVideoEncoder  = 0x400
	rateControlCBR         = 0
	rateControlLowDelayVBR = 4
	h264ProfileHigh        = 100
	h264ProfileMain        = 77
	nv12Ring               = 4
)

type mftTypeInfo struct{ Major, Sub wincom.GUID }

type mftOutputStreamInfo struct{ Flags, Size, Alignment uint32 }

type mftOutputDataBuffer struct {
	StreamID uint32
	Sample   unsafe.Pointer
	Status   uint32
	Events   unsafe.Pointer
}

type variant struct {
	Vt  uint16
	_   [3]uint16
	Val uint64
	_   uintptr
}

type vpContentDesc struct {
	InputFrameFormat       uint32
	InRateNum, InRateDen   uint32
	InWidth, InHeight      uint32
	OutRateNum, OutRateDen uint32
	OutWidth, OutHeight    uint32
	Usage                  uint32
}

type vpInputViewDesc struct{ FourCC, ViewDimension, MipSlice, ArraySlice uint32 }

type vpOutputViewDesc struct{ ViewDimension, MipSlice, FirstArraySlice, ArraySize uint32 }

type vpStream struct {
	Enable                                     int32
	OutputIndex, InputFrameOrField             uint32
	PastFrames, FutureFrames                   uint32
	PastSurfaces, InputSurface, FutureSurfaces unsafe.Pointer
	PastRight, InputSurfaceRight, FutureRight  unsafe.Pointer
}

// VideoThread 把当前 goroutine 固定到一个系统线程并初始化 COM（多线程套间），视频流的所有调用都要在这个 goroutine 里。
// 返回的函数在结束时调用。
func VideoThread() func() {
	runtime.LockOSThread()
	hr := wincom.Proc(procCoInitializeEx, 0, 0) // COINIT_MULTITHREADED
	return func() {
		if hr >= 0 {
			procCoUninitialize.Call()
		}
		runtime.UnlockOSThread()
	}
}

// VideoStream 一个显示器的硬件 H.264 视频流。
type VideoStream struct {
	cfg  VideoConfig
	cap  *dxgiCapturer
	name string // 编码器名字

	vdev, vctx, venum, vproc wincom.Obj
	inViews                  map[unsafe.Pointer]wincom.Obj // 桌面复制的纹理 → 视频处理器输入视图
	copyTex                  wincom.Obj                    // 显卡不能直接读桌面复制的纹理时，先复制到这里
	directInput              bool
	seedTex                  wincom.Obj // 画面一直不变时，用 GDI 截的第一帧
	nv12                     [nv12Ring]wincom.Obj
	outViews                 [nv12Ring]wincom.Obj
	ring, lastFed            int

	devMgr    wincom.Obj
	token     uint32
	activate  wincom.Obj
	mft       wincom.Obj
	codec     wincom.Obj
	events    wincom.Obj
	needInput int
	provides  bool
	outSize   uint32
	seqHeader []byte
	start     time.Time
	fedOnce   bool
	forceKey  bool

	// 系统写入的输出参数放在结构体里（在堆上），调用期间不会被搬走
	info   dxgiFrameInfo
	acts   unsafe.Pointer
	nacts  uint32
	inInfo mftTypeInfo
	ouInfo mftTypeInfo
}

// OpenVideo 打开显示器 d 的硬件 H.264 视频流。调用方要先调用 VideoThread。
func OpenVideo(d Display, cfg VideoConfig) (*VideoStream, error) {
	if procMFCreateDXGIDeviceManager.Find() != nil || procMFCreateDXGISurfaceBuffer.Find() != nil {
		return nil, errors.New("系统的 Media Foundation 不支持显卡编码（需要 Windows 8 及以上）")
	}
	mfStartOnce.Do(func() { mfStartErr = wincom.Proc(procMFStartup, mfVersion, 0).Err("MFStartup") })
	if mfStartErr != nil {
		return nil, mfStartErr
	}
	if cfg.FPS <= 0 {
		cfg.FPS = 30
	}
	cfg.Width, cfg.Height = cfg.Width&^1, cfg.Height&^1
	if cfg.Width < 64 || cfg.Height < 64 {
		return nil, fmt.Errorf("视频尺寸 %dx%d 太小", cfg.Width, cfg.Height)
	}
	if cfg.Bitrate <= 0 {
		cfg.Bitrate = DefaultBitrate(cfg.Width, cfg.Height, cfg.FPS)
	}
	c, err := openDXGI(d.Bounds)
	if err != nil {
		return nil, err
	}
	v := &VideoStream{cfg: cfg, cap: c, inViews: map[unsafe.Pointer]wincom.Obj{}, directInput: true, start: time.Now()}
	if err := v.init(); err != nil {
		v.Close()
		return nil, err
	}
	return v, nil
}

// DefaultBitrate 默认码率：每像素每帧 0.12 比特，限制在 2～40 Mbps。
func DefaultBitrate(w, h, fps int) int {
	br := int(float64(w*h*fps) * 0.12)
	if br < 2_000_000 {
		br = 2_000_000
	}
	if br > 40_000_000 {
		br = 40_000_000
	}
	return br
}

func (v *VideoStream) init() error {
	dev := v.cap.device
	// 编码器在自己的线程里用这个设备，要打开多线程保护
	if mt, err := dev.QueryInterface(&iidID3D10Multithread); err == nil {
		mt.Call(mtSetProtected, 1)
		mt.Release()
	}
	if err := v.initProcessor(); err != nil {
		return err
	}
	if hr := wincom.Proc(procMFCreateDXGIDeviceManager, uintptr(unsafe.Pointer(&v.token)), uintptr(unsafe.Pointer(&v.devMgr.P))); hr.Failed() {
		return hr.Err("MFCreateDXGIDeviceManager")
	}
	if hr := v.devMgr.Call(devMgrResetDevice, dev.Ptr(), uintptr(v.token)); hr.Failed() {
		return hr.Err("ResetDevice")
	}
	return v.initEncoder()
}

// initProcessor 视频处理器：桌面画面（BGRA）→ 缩放到输出尺寸的 NV12。
func (v *VideoStream) initProcessor() error {
	var err error
	if v.vdev, err = v.cap.device.QueryInterface(&iidID3D11VideoDevice); err != nil {
		return errors.New("显卡驱动不支持视频处理（ID3D11VideoDevice）")
	}
	if v.vctx, err = v.cap.ctx.QueryInterface(&iidID3D11VideoContext); err != nil {
		return errors.New("显卡驱动不支持视频处理（ID3D11VideoContext）")
	}
	b := v.cap.bounds
	desc := &vpContentDesc{InRateNum: uint32(v.cfg.FPS), InRateDen: 1, InWidth: uint32(b.Dx()), InHeight: uint32(b.Dy()),
		OutRateNum: uint32(v.cfg.FPS), OutRateDen: 1, OutWidth: uint32(v.cfg.Width), OutHeight: uint32(v.cfg.Height)}
	var hr wincom.HRESULT
	if v.venum, hr = v.vdev.Out(vdevCreateEnumerator, uintptr(unsafe.Pointer(desc))); hr.Failed() {
		return hr.Err("CreateVideoProcessorEnumerator")
	}
	if v.vproc, hr = v.vdev.Out(vdevCreateProcessor, v.venum.Ptr(), 0); hr.Failed() {
		return hr.Err("CreateVideoProcessor")
	}
	// 输入是全范围 RGB；输出 BT.709、16～235（高清视频的默认约定，手机解码器没收到颜色信息时也按这个显示）
	var csIn, csOut uint32 = 0, 1<<2 | 1<<4
	v.vctx.Call(vctxSetStreamColorSpace, v.vproc.Ptr(), 0, uintptr(unsafe.Pointer(&csIn)))
	v.vctx.Call(vctxSetOutputColorSpace, v.vproc.Ptr(), uintptr(unsafe.Pointer(&csOut)))
	v.vctx.Call(vctxSetStreamAutoProc, v.vproc.Ptr(), 0, 0)

	for i := range v.nv12 {
		for _, bind := range []uint32{d3d11BindRenderTarget | d3d11BindVideoEncoder, d3d11BindRenderTarget} {
			td := &tex2DDesc{Width: uint32(v.cfg.Width), Height: uint32(v.cfg.Height), MipLevels: 1, ArraySize: 1,
				Format: dxgiFormatNV12, SampleCount: 1, BindFlags: bind}
			if t, hr := v.cap.device.Out(deviceCreateTexture2D, uintptr(unsafe.Pointer(td)), 0); !hr.Failed() {
				v.nv12[i] = t
				break
			}
		}
		if v.nv12[i].Nil() {
			return errors.New("显卡不能创建 NV12 纹理")
		}
		od := &vpOutputViewDesc{ViewDimension: 1} // D3D11_VPOV_DIMENSION_TEXTURE2D
		if v.outViews[i], hr = v.vdev.Out(vdevCreateOutputView, v.nv12[i].Ptr(), v.venum.Ptr(), uintptr(unsafe.Pointer(od))); hr.Failed() {
			return hr.Err("CreateVideoProcessorOutputView")
		}
	}
	return nil
}

// initEncoder 找一个能用的硬件 H.264 编码器并配置好。
func (v *VideoStream) initEncoder() error {
	v.inInfo = mftTypeInfo{Major: mfMediaTypeVideo, Sub: mfVideoFormatNV12}
	v.ouInfo = mftTypeInfo{Major: mfMediaTypeVideo, Sub: mfVideoFormatH264}
	flags := uintptr(mftEnumFlagHardware | mftEnumFlagSortFilter)
	var hr wincom.HRESULT
	if unsafe.Sizeof(uintptr(0)) == 8 {
		// 64 位：16 字节的 GUID 按值传参时实际传的是地址
		hr = wincom.Proc(procMFTEnumEx, uintptr(unsafe.Pointer(&mftCategoryVideoEncoder)), flags,
			uintptr(unsafe.Pointer(&v.inInfo)), uintptr(unsafe.Pointer(&v.ouInfo)), uintptr(unsafe.Pointer(&v.acts)), uintptr(unsafe.Pointer(&v.nacts)))
	} else {
		// 32 位 stdcall：GUID 按值拆成 4 个 32 位参数压栈
		g := (*[4]uint32)(unsafe.Pointer(&mftCategoryVideoEncoder))
		hr = wincom.Proc(procMFTEnumEx, uintptr(g[0]), uintptr(g[1]), uintptr(g[2]), uintptr(g[3]), flags,
			uintptr(unsafe.Pointer(&v.inInfo)), uintptr(unsafe.Pointer(&v.ouInfo)), uintptr(unsafe.Pointer(&v.acts)), uintptr(unsafe.Pointer(&v.nacts)))
	}
	if hr.Failed() {
		return hr.Err("MFTEnumEx")
	}
	if v.nacts == 0 || v.acts == nil {
		return errors.New("没有找到显卡的 H.264 硬件编码器")
	}
	acts := unsafe.Slice((*unsafe.Pointer)(v.acts), v.nacts)
	var lastErr error
	for _, p := range acts {
		a := wincom.Obj{P: p}
		if v.activate.Nil() {
			if err := v.tryEncoder(a); err == nil {
				v.activate = a
				continue
			} else {
				lastErr = err
				v.releaseEncoder()
				a.Call(activateShutdownObject)
			}
		}
		a.Release()
	}
	procCoTaskMemFree.Call(uintptr(v.acts))
	v.acts = nil
	if v.activate.Nil() {
		return fmt.Errorf("硬件编码器都用不了：%v", lastErr)
	}
	return nil
}

func (v *VideoStream) tryEncoder(a wincom.Obj) error {
	v.name = allocatedString(a, &mftFriendlyName)
	mft, hr := a.Out(activateActivateObject, uintptr(unsafe.Pointer(&iidIMFTransform)))
	if hr.Failed() {
		return hr.Err(v.name + " ActivateObject")
	}
	v.mft = mft
	if attrs, hr := mft.Out(mftGetAttributes); !hr.Failed() {
		attrs.Call(attrSetUINT32, uintptr(unsafe.Pointer(&mfTransformAsyncUnlock)), 1)
		attrs.Release()
	}
	if hr := mft.Call(mftProcessMessage, mftMsgSetD3DManager, v.devMgr.Ptr()); hr.Failed() {
		return hr.Err(v.name + " 设置显卡设备")
	}
	if c, err := mft.QueryInterface(&iidICodecAPI); err == nil {
		v.codec = c
		v.setCodecBool(&codecLowLatency, true)
		if v.setCodecUI4(&codecRateControl, rateControlLowDelayVBR).Failed() {
			v.setCodecUI4(&codecRateControl, rateControlCBR)
		}
		v.setCodecUI4(&codecMeanBitRate, uint32(v.cfg.Bitrate))
		v.setCodecUI4(&codecBPictureCount, 0)
		v.setCodecUI4(&codecGOPSize, uint32(v.cfg.FPS*120)) // 关键帧只在开始和手机要的时候发
	}
	// 硬件编码器要先设输出类型再设输入类型
	var err error
	for _, profile := range []uint32{h264ProfileHigh, h264ProfileMain} {
		if err = v.setType(true, profile); err == nil {
			break
		}
	}
	if err != nil {
		return err
	}
	if err := v.setType(false, 0); err != nil {
		return err
	}
	var si mftOutputStreamInfo
	if hr := mft.Call(mftGetOutputStreamInfo, 0, uintptr(unsafe.Pointer(&si))); hr.Failed() {
		return hr.Err("GetOutputStreamInfo")
	}
	v.provides, v.outSize = si.Flags&mftProvidesSamples != 0, si.Size
	if v.outSize == 0 {
		v.outSize = uint32(v.cfg.Width * v.cfg.Height * 3 / 2)
	}
	v.readSeqHeader()
	ev, err := mft.QueryInterface(&iidIMFEventGenerator)
	if err != nil {
		return errors.New(v.name + " 不是异步编码器")
	}
	v.events = ev
	mft.Call(mftProcessMessage, mftMsgBeginStreaming, 0)
	mft.Call(mftProcessMessage, mftMsgStartOfStream, 0)
	return nil
}

func (v *VideoStream) setType(output bool, profile uint32) error {
	var mt wincom.Obj
	if hr := wincom.Proc(procMFCreateMediaType, uintptr(unsafe.Pointer(&mt.P))); hr.Failed() {
		return hr.Err("MFCreateMediaType")
	}
	defer mt.Release()
	sub := &mfVideoFormatNV12
	if output {
		sub = &mfVideoFormatH264
	}
	mt.Call(attrSetGUID, uintptr(unsafe.Pointer(&mfMTMajorType)), uintptr(unsafe.Pointer(&mfMediaTypeVideo)))
	mt.Call(attrSetGUID, uintptr(unsafe.Pointer(&mfMTSubtype)), uintptr(unsafe.Pointer(sub)))
	setU64(mt, attrSetUINT64, &mfMTFrameSize, uint64(v.cfg.Width)<<32|uint64(v.cfg.Height))
	setU64(mt, attrSetUINT64, &mfMTFrameRate, uint64(v.cfg.FPS)<<32|1)
	setU64(mt, attrSetUINT64, &mfMTPixelAspectRatio, 1<<32|1)
	mt.Call(attrSetUINT32, uintptr(unsafe.Pointer(&mfMTInterlaceMode)), 2) // 逐行
	mt.Call(attrSetUINT32, uintptr(unsafe.Pointer(&mfMTYUVMatrix)), 1)     // BT.709
	mt.Call(attrSetUINT32, uintptr(unsafe.Pointer(&mfMTNominalRange)), 2)  // 16～235
	if output {
		mt.Call(attrSetUINT32, uintptr(unsafe.Pointer(&mfMTAvgBitrate)), uintptr(v.cfg.Bitrate))
		mt.Call(attrSetUINT32, uintptr(unsafe.Pointer(&mfMTMpeg2Profile)), uintptr(profile))
		return v.mft.Call(mftSetOutputType, 0, mt.Ptr(), 0).Err(v.name + " 设置输出格式")
	}
	return v.mft.Call(mftSetInputType, 0, mt.Ptr(), 0).Err(v.name + " 设置输入格式（NV12）")
}

// readSeqHeader 有的编码器不在关键帧里带 SPS/PPS，而是放在输出格式里，取出来备用。
func (v *VideoStream) readSeqHeader() {
	mt, hr := v.mft.Out(mftGetOutputCurrentType, 0)
	if hr.Failed() {
		return
	}
	defer mt.Release()
	var size uint32
	if mt.Call(attrGetBlobSize, uintptr(unsafe.Pointer(&mfMTMpegSequenceHeader)), uintptr(unsafe.Pointer(&size))).Failed() || size == 0 || size > 4096 {
		return
	}
	buf := make([]byte, size)
	if mt.Call(attrGetBlob, uintptr(unsafe.Pointer(&mfMTMpegSequenceHeader)), uintptr(unsafe.Pointer(&buf[0])), uintptr(size), uintptr(unsafe.Pointer(&size))).Failed() {
		return
	}
	v.seqHeader = buf[:size]
}

func (v *VideoStream) setCodecUI4(key *wincom.GUID, val uint32) wincom.HRESULT {
	vr := &variant{Vt: vtUI4, Val: uint64(val)}
	return v.codec.Call(codecSetValue, uintptr(unsafe.Pointer(key)), uintptr(unsafe.Pointer(vr)))
}

func (v *VideoStream) setCodecBool(key *wincom.GUID, on bool) wincom.HRESULT {
	vr := &variant{Vt: vtBool}
	if on {
		vr.Val = 0xffff // VARIANT_TRUE
	}
	return v.codec.Call(codecSetValue, uintptr(unsafe.Pointer(key)), uintptr(unsafe.Pointer(vr)))
}

// setU64 调用参数是 (GUID*, UINT64) 的方法：32 位系统上 UINT64 要拆成两个参数。
func setU64(o wincom.Obj, method int, key *wincom.GUID, val uint64) {
	if unsafe.Sizeof(uintptr(0)) == 8 {
		o.Call(method, uintptr(unsafe.Pointer(key)), uintptr(val))
	} else {
		o.Call(method, uintptr(unsafe.Pointer(key)), uintptr(uint32(val)), uintptr(val>>32))
	}
}

// callI64 调用参数只有一个 INT64 的方法（设置样本时间）。
func callI64(o wincom.Obj, method int, val int64) {
	if unsafe.Sizeof(uintptr(0)) == 8 {
		o.Call(method, uintptr(val))
	} else {
		o.Call(method, uintptr(uint32(val)), uintptr(uint64(val)>>32))
	}
}

func allocatedString(o wincom.Obj, key *wincom.GUID) string {
	var p *uint16
	var n uint32
	if o.Call(attrGetAllocatedString, uintptr(unsafe.Pointer(key)), uintptr(unsafe.Pointer(&p)), uintptr(unsafe.Pointer(&n))).Failed() || p == nil {
		return "硬件编码器"
	}
	s := syscall.UTF16ToString(unsafe.Slice(p, n))
	procCoTaskMemFree.Call(uintptr(unsafe.Pointer(p)))
	return s
}

// Name 编码器名字（日志用）。
func (v *VideoStream) Name() string { return v.name }

// Size 输出画面尺寸。
func (v *VideoStream) Size() (int, int) { return v.cfg.Width, v.cfg.Height }

// RequestKeyFrame 下一帧编成关键帧（手机端解码出错或刚打开画面时要）。
func (v *VideoStream) RequestKeyFrame() { v.forceKey = true }

// SetBitrate 运行中调整码率。
func (v *VideoStream) SetBitrate(bps int) {
	if !v.codec.Nil() && bps > 0 {
		v.cfg.Bitrate = bps
		v.setCodecUI4(&codecMeanBitRate, uint32(bps))
	}
}

// Poll 处理编码器的事件，不等待。有编码好的帧就返回它；没有返回 nil。
func (v *VideoStream) Poll() (*VideoFrame, error) {
	for {
		ev, hr := v.events.Out(genGetEvent, mfEventFlagNoWait)
		if hr == mfENoEventsAvailable {
			return nil, nil
		}
		if hr.Failed() {
			return nil, hr.Err(v.name + " GetEvent")
		}
		var typ uint32
		ev.Call(eventGetType, uintptr(unsafe.Pointer(&typ)))
		ev.Release()
		switch typ {
		case meTransformNeedInput:
			v.needInput++
		case meTransformHaveOutput:
			f, err := v.output()
			if err != nil || f != nil {
				return f, err
			}
		}
	}
}

// CanFeed 编码器在等新画面。
func (v *VideoStream) CanFeed() bool { return v.needInput > 0 }

// Feed 编码器要输入时，等桌面的下一帧（最多等 wait）送进去。返回是否送了一帧。
// 刚开始时画面一直不变，桌面复制不给画面，这时用 GDI 截一张送进去，手机才有第一帧。
func (v *VideoStream) Feed(wait time.Duration) (bool, error) {
	if v.needInput == 0 {
		return false, nil
	}
	c := v.cap
	if c.dupl.Nil() {
		if err := c.duplicate(); err != nil {
			return false, errDuplicationLost
		}
		v.clearInputViews()
	}
	res, hr := c.dupl.Out(duplAcquireNextFrame, uintptr(wait/time.Millisecond), uintptr(unsafe.Pointer(&v.info)))
	switch {
	case hr == dxgiErrWaitTimeout:
		if !v.fedOnce {
			return v.feedSeed()
		}
		return false, nil
	case hr == dxgiErrAccessLost:
		c.dupl.Release()
		return false, errDuplicationLost
	case hr.Failed():
		c.dupl.Release()
		return false, hr.Err("AcquireNextFrame")
	}
	defer c.dupl.Call(duplReleaseFrame)
	defer res.Release()
	if v.info.LastPresentTime == 0 {
		if !v.fedOnce {
			return v.feedSeed()
		}
		return false, nil // 只有鼠标动了
	}
	tex, err := res.QueryInterface(&iidID3D11Texture2D)
	if err != nil {
		return false, err
	}
	defer tex.Release()
	src := tex
	if !v.directInput {
		if err := v.ensureCopyTex(); err != nil {
			return false, err
		}
		c.ctx.Call(ctxCopyResource, v.copyTex.Ptr(), tex.Ptr())
		src = v.copyTex
	}
	view, err := v.inputView(src)
	if err != nil && v.directInput {
		// 有的显卡不能直接读桌面复制的纹理：以后都先复制一份
		v.directInput = false
		if err := v.ensureCopyTex(); err != nil {
			return false, err
		}
		c.ctx.Call(ctxCopyResource, v.copyTex.Ptr(), tex.Ptr())
		view, err = v.inputView(v.copyTex)
	}
	if err != nil {
		return false, err
	}
	return v.convertAndFeed(view)
}

// Refeed 把上一帧再送一次（画面停下来后让编码器把画质补上去）。
func (v *VideoStream) Refeed() (bool, error) {
	if v.needInput == 0 || !v.fedOnce {
		return false, nil
	}
	return v.feedSample(v.lastFed)
}

func (v *VideoStream) feedSeed() (bool, error) {
	img, err := Capture(v.cap.bounds)
	if err != nil {
		return false, nil
	}
	if v.seedTex.Nil() {
		td := &tex2DDesc{Width: uint32(img.Rect.Dx()), Height: uint32(img.Rect.Dy()), MipLevels: 1, ArraySize: 1,
			Format: dxgiFormatRGBA, SampleCount: 1, BindFlags: d3d11BindShaderRes | d3d11BindRenderTarget}
		t, hr := v.cap.device.Out(deviceCreateTexture2D, uintptr(unsafe.Pointer(td)), 0)
		if hr.Failed() {
			return false, nil
		}
		v.seedTex = t
	}
	v.cap.ctx.Call(ctxUpdateSubresource, v.seedTex.Ptr(), 0, 0, uintptr(unsafe.Pointer(&img.Pix[0])), uintptr(img.Stride), 0)
	runtime.KeepAlive(img)
	view, err := v.inputView(v.seedTex)
	if err != nil {
		return false, nil
	}
	return v.convertAndFeed(view)
}

func (v *VideoStream) ensureCopyTex() error {
	if !v.copyTex.Nil() {
		return nil
	}
	b := v.cap.bounds
	td := &tex2DDesc{Width: uint32(b.Dx()), Height: uint32(b.Dy()), MipLevels: 1, ArraySize: 1,
		Format: dxgiFormatBGRA, SampleCount: 1, BindFlags: d3d11BindShaderRes | d3d11BindRenderTarget}
	t, hr := v.cap.device.Out(deviceCreateTexture2D, uintptr(unsafe.Pointer(td)), 0)
	if hr.Failed() {
		return hr.Err("CreateTexture2D（复制桌面画面）")
	}
	v.copyTex = t
	return nil
}

func (v *VideoStream) inputView(tex wincom.Obj) (wincom.Obj, error) {
	if view, ok := v.inViews[tex.P]; ok {
		return view, nil
	}
	d := &vpInputViewDesc{ViewDimension: 1} // D3D11_VPIV_DIMENSION_TEXTURE2D
	view, hr := v.vdev.Out(vdevCreateInputView, tex.Ptr(), v.venum.Ptr(), uintptr(unsafe.Pointer(d)))
	if hr.Failed() {
		return wincom.Obj{}, hr.Err("CreateVideoProcessorInputView")
	}
	v.inViews[tex.P] = view
	return view, nil
}

func (v *VideoStream) clearInputViews() {
	for k, view := range v.inViews {
		view.Release()
		delete(v.inViews, k)
	}
}

// convertAndFeed 用视频处理器把输入视图转成 NV12（同时缩放）写进环形缓冲的下一张纹理，再送给编码器。
func (v *VideoStream) convertAndFeed(view wincom.Obj) (bool, error) {
	i := v.ring
	st := &vpStream{Enable: 1, InputSurface: view.P}
	if hr := v.vctx.Call(vctxBlt, v.vproc.Ptr(), v.outViews[i].Ptr(), 0, 1, uintptr(unsafe.Pointer(st))); hr.Failed() {
		return false, hr.Err("VideoProcessorBlt")
	}
	v.ring = (v.ring + 1) % nv12Ring
	return v.feedSample(i)
}

func (v *VideoStream) feedSample(i int) (bool, error) {
	var buf, sample wincom.Obj
	if hr := wincom.Proc(procMFCreateDXGISurfaceBuffer, uintptr(unsafe.Pointer(&iidID3D11Texture2D)), v.nv12[i].Ptr(), 0, 0, uintptr(unsafe.Pointer(&buf.P))); hr.Failed() {
		return false, hr.Err("MFCreateDXGISurfaceBuffer")
	}
	defer buf.Release()
	buf.Call(bufferSetCurrentLength, uintptr(v.cfg.Width*v.cfg.Height*3/2))
	if hr := wincom.Proc(procMFCreateSample, uintptr(unsafe.Pointer(&sample.P))); hr.Failed() {
		return false, hr.Err("MFCreateSample")
	}
	defer sample.Release()
	sample.Call(sampleAddBuffer, buf.Ptr())
	callI64(sample, sampleSetTime, int64(time.Since(v.start)/100))
	callI64(sample, sampleSetDuration, int64(time.Second/100)/int64(v.cfg.FPS))
	if v.forceKey && !v.codec.Nil() {
		v.setCodecUI4(&codecForceKeyFrame, 1)
		v.forceKey = false
	}
	hr := v.mft.Call(mftProcessInput, 0, sample.Ptr(), 0)
	if hr == mfENotAccepting {
		return false, nil
	}
	if hr.Failed() {
		return false, hr.Err(v.name + " ProcessInput")
	}
	v.needInput--
	v.lastFed, v.fedOnce = i, true
	return true, nil
}

// output 取一帧编码结果。
func (v *VideoStream) output() (*VideoFrame, error) {
	out := &mftOutputDataBuffer{}
	var own wincom.Obj
	if !v.provides {
		var mem wincom.Obj
		if hr := wincom.Proc(procMFCreateSample, uintptr(unsafe.Pointer(&own.P))); hr.Failed() {
			return nil, hr.Err("MFCreateSample")
		}
		if hr := wincom.Proc(procMFCreateMemoryBuffer, uintptr(v.outSize), uintptr(unsafe.Pointer(&mem.P))); hr.Failed() {
			own.Release()
			return nil, hr.Err("MFCreateMemoryBuffer")
		}
		own.Call(sampleAddBuffer, mem.Ptr())
		mem.Release()
		out.Sample = own.P
	}
	var status uint32
	hr := v.mft.Call(mftProcessOutput, 0, 1, uintptr(unsafe.Pointer(out)), uintptr(unsafe.Pointer(&status)))
	if out.Events != nil {
		ev := wincom.Obj{P: out.Events}
		ev.Release()
	}
	sample := wincom.Obj{P: out.Sample}
	if v.provides {
		defer sample.Release()
	} else {
		defer own.Release()
	}
	switch {
	case hr == mfETransformStreamChange:
		// 编码器改了输出格式：重新取一次并设置
		if mt, hr := v.mft.Out(mftGetOutputAvailType, 0, 0); !hr.Failed() {
			v.mft.Call(mftSetOutputType, 0, mt.Ptr(), 0)
			mt.Release()
		}
		v.readSeqHeader()
		return nil, nil
	case hr == mfETransformNeedInput:
		return nil, nil
	case hr.Failed():
		return nil, hr.Err(v.name + " ProcessOutput")
	}
	if sample.Nil() {
		return nil, nil
	}
	buf, hr := sample.Out(sampleToContiguous)
	if hr.Failed() {
		return nil, hr.Err("ConvertToContiguousBuffer")
	}
	defer buf.Release()
	var p *byte
	var maxLen, cur uint32
	if hr := buf.Call(bufferLock, uintptr(unsafe.Pointer(&p)), uintptr(unsafe.Pointer(&maxLen)), uintptr(unsafe.Pointer(&cur))); hr.Failed() {
		return nil, hr.Err("Lock")
	}
	data := make([]byte, cur)
	copy(data, unsafe.Slice(p, cur))
	buf.Call(bufferUnlock)
	f := &VideoFrame{Data: data, Key: hasNAL(data, 5)}
	if f.Key && !hasNAL(data, 7) && len(v.seqHeader) > 0 {
		f.Data = append(append([]byte(nil), v.seqHeader...), data...)
	}
	return f, nil
}

func (v *VideoStream) releaseEncoder() {
	v.events.Release()
	v.codec.Release()
	v.mft.Release()
	v.needInput = 0
}

// Close 停止编码并释放所有资源。
func (v *VideoStream) Close() {
	if !v.mft.Nil() {
		v.mft.Call(mftProcessMessage, mftMsgEndOfStream, 0)
		v.mft.Call(mftProcessMessage, mftMsgEndStreaming, 0)
		v.mft.Call(mftProcessMessage, mftMsgCommandFlush, 0)
	}
	v.releaseEncoder()
	if !v.activate.Nil() {
		v.activate.Call(activateShutdownObject)
		v.activate.Release()
	}
	v.devMgr.Release()
	v.clearInputViews()
	for i := range v.nv12 {
		v.outViews[i].Release()
		v.nv12[i].Release()
	}
	v.copyTex.Release()
	v.seedTex.Release()
	v.vproc.Release()
	v.venum.Release()
	v.vctx.Release()
	v.vdev.Release()
	if v.cap != nil {
		v.cap.Close()
		v.cap = nil
	}
}
