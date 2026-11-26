//go:build darwin && cgo

package usbio

// macOS：用 IOKit 的用户态 USB 接口（IOUSBLib）直接读写手机 ADB 接口的 bulk 端点，不需要 adb 和驱动。
// 安卓手机的 ADB 接口（FF/42/01）系统没有驱动认领，普通用户就能打开；被别的程序（如 Android Studio 的 adb）
// 打开着时 USBInterfaceOpen 返回独占错误，按 ErrBusy 处理。
//
// 做法和 Android adb 的 client/usb_osx.cpp 类似：枚举 IOUSBHostInterface（10.11 起的 USB 栈），
// 按接口类型找到 ADB 接口，从父节点（USB 设备）读厂商 / 产品 ID、序列号、产品名；
// 打开时按注册表 ID 找回这个接口，建 IOUSBInterfaceInterface 插件，打开接口，找一对 bulk 端点。
// 读用不带超时的 ReadPipe（带超时的 ReadPipeTO 超时后端点会被中止、数据可能丢失），Close 时用 AbortPipe 唤醒。

/*
#cgo CFLAGS: -mmacosx-version-min=10.13 -Wno-deprecated-declarations
#cgo LDFLAGS: -framework IOKit -framework CoreFoundation

#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <CoreFoundation/CoreFoundation.h>
#include <IOKit/IOKitLib.h>
#include <IOKit/IOCFPlugIn.h>
#include <IOKit/usb/IOUSBLib.h>

// 接口版本：300 从 10.5 起就有，新 SDK 里只是标为过时，ReadPipe / WritePipeTO / AbortPipe 都在
typedef IOUSBInterfaceInterface300 **p2d_intf;

typedef struct {
	uint64_t id;       // 接口的注册表 ID，重新插拔会变
	uint16_t vid, pid;
	char serial[128];
	char product[128];
} p2d_adbdev;

typedef struct {
	p2d_intf intf;
	uint8_t in, out;   // pipeRef（从 1 开始的端点序号），不是端点地址
	uint16_t maxPacket; // OUT 端点的最大包长
} p2d_pipe;

static CFTypeRef p2d_prop(io_registry_entry_t e, const char *key) {
	CFStringRef k = CFStringCreateWithCString(kCFAllocatorDefault, key, kCFStringEncodingUTF8);
	if (!k) return NULL;
	CFTypeRef v = IORegistryEntryCreateCFProperty(e, k, kCFAllocatorDefault, 0);
	CFRelease(k);
	return v;
}

static int p2d_num(io_registry_entry_t e, const char *key, int64_t *out) {
	CFTypeRef v = p2d_prop(e, key);
	if (!v) return 0;
	int ok = 0;
	if (CFGetTypeID(v) == CFNumberGetTypeID()) ok = CFNumberGetValue((CFNumberRef)v, kCFNumberSInt64Type, out) ? 1 : 0;
	CFRelease(v);
	return ok;
}

static int p2d_str(io_registry_entry_t e, const char *key, char *buf, int size) {
	CFTypeRef v = p2d_prop(e, key);
	if (!v) return 0;
	int ok = 0;
	if (CFGetTypeID(v) == CFStringGetTypeID()) ok = CFStringGetCString((CFStringRef)v, buf, size, kCFStringEncodingUTF8) ? 1 : 0;
	CFRelease(v);
	if (!ok) buf[0] = 0;
	return ok;
}

// p2d_list 列出插着的设备上的 ADB 接口，最多 max 个，个数写到 count；返回 kern_return_t
static int p2d_list(p2d_adbdev *out, int max, int *count) {
	io_iterator_t it = 0;
	*count = 0;
	// 传 0（MACH_PORT_NULL）就是默认端口：kIOMasterPortDefault 在 12.0 改名为 kIOMainPortDefault，旧 SDK 没有新名字
	kern_return_t kr = IOServiceGetMatchingServices(0, IOServiceMatching("IOUSBHostInterface"), &it);
	if (kr != KERN_SUCCESS) return kr;
	int n = 0;
	io_service_t svc;
	while ((svc = IOIteratorNext(it)) != 0) {
		int64_t cls = -1, sub = -1, proto = -1;
		if (n < max && p2d_num(svc, "bInterfaceClass", &cls) && p2d_num(svc, "bInterfaceSubClass", &sub) &&
			p2d_num(svc, "bInterfaceProtocol", &proto) && cls == 0xFF && sub == 0x42 && proto == 0x01) {
			p2d_adbdev *d = &out[n];
			memset(d, 0, sizeof(*d));
			if (IORegistryEntryGetRegistryEntryID(svc, &d->id) == KERN_SUCCESS) {
				io_registry_entry_t dev = 0;
				if (IORegistryEntryGetParentEntry(svc, kIOServicePlane, &dev) == KERN_SUCCESS) {
					int64_t v = 0;
					if (p2d_num(dev, "idVendor", &v)) d->vid = (uint16_t)v;
					if (p2d_num(dev, "idProduct", &v)) d->pid = (uint16_t)v;
					if (!p2d_str(dev, "USB Serial Number", d->serial, sizeof(d->serial)))
						p2d_str(dev, "kUSBSerialNumberString", d->serial, sizeof(d->serial));
					if (!p2d_str(dev, "USB Product Name", d->product, sizeof(d->product)))
						p2d_str(dev, "kUSBProductString", d->product, sizeof(d->product));
					IOObjectRelease(dev);
				}
				n++;
			}
		}
		IOObjectRelease(svc);
	}
	IOObjectRelease(it);
	*count = n;
	return KERN_SUCCESS;
}

// p2d_open 按注册表 ID 打开 ADB 接口。成功返回 0，失败返回 IOReturn；-1 表示没找到一对 bulk 端点
static int p2d_open(uint64_t id, p2d_pipe **out) {
	*out = NULL;
	io_service_t svc = IOServiceGetMatchingService(0, IORegistryEntryIDMatching(id));
	if (!svc) return kIOReturnNoDevice;
	IOCFPlugInInterface **plugin = NULL;
	SInt32 score = 0;
	IOReturn r = IOCreatePlugInInterfaceForService(svc, kIOUSBInterfaceUserClientTypeID, kIOCFPlugInInterfaceID, &plugin, &score);
	IOObjectRelease(svc);
	if (r != kIOReturnSuccess || !plugin) return r != kIOReturnSuccess ? r : kIOReturnError;
	p2d_intf intf = NULL;
	HRESULT hr = (*plugin)->QueryInterface(plugin, CFUUIDGetUUIDBytes(kIOUSBInterfaceInterfaceID300), (LPVOID *)&intf);
	IODestroyPlugInInterface(plugin);
	if (hr != S_OK || !intf) return kIOReturnError;
	r = (*intf)->USBInterfaceOpen(intf);
	if (r != kIOReturnSuccess) {
		(*intf)->Release(intf);
		return r;
	}
	UInt8 count = 0;
	(*intf)->GetNumEndpoints(intf, &count);
	uint8_t in = 0, outp = 0;
	uint16_t mp = 0;
	for (UInt8 i = 1; i <= count; i++) {
		UInt8 dir = 0, num = 0, type = 0, interval = 0;
		UInt16 size = 0;
		if ((*intf)->GetPipeProperties(intf, i, &dir, &num, &type, &size, &interval) != kIOReturnSuccess) continue;
		if (type != kUSBBulk) continue;
		if (dir == kUSBIn && !in) in = i;
		if (dir == kUSBOut && !outp) {
			outp = i;
			mp = size;
		}
	}
	if (!in || !outp) {
		(*intf)->USBInterfaceClose(intf);
		(*intf)->Release(intf);
		return -1;
	}
	p2d_pipe *p = (p2d_pipe *)calloc(1, sizeof(p2d_pipe));
	if (!p) {
		(*intf)->USBInterfaceClose(intf);
		(*intf)->Release(intf);
		return kIOReturnNoMemory;
	}
	p->intf = intf;
	p->in = in;
	p->out = outp;
	p->maxPacket = mp;
	*out = p;
	return 0;
}

// p2d_read 读一次，一直等到有数据、出错或被 p2d_abort 中止。端点卡住（stall）时清掉，返回 0 字节让调用方再读
static int p2d_read(p2d_pipe *p, void *buf, uint32_t *size) {
	IOReturn r = (*p->intf)->ReadPipe(p->intf, p->in, buf, size);
	if (r == kIOUSBPipeStalled) {
		(*p->intf)->ClearPipeStallBothEnds(p->intf, p->in);
		*size = 0;
		return 0;
	}
	return r;
}

static int p2d_write(p2d_pipe *p, void *buf, uint32_t size, uint32_t timeoutMs) {
	static uint8_t empty[1];
	if (size == 0) buf = empty; // 零长度包
	IOReturn r = (*p->intf)->WritePipeTO(p->intf, p->out, buf, size, timeoutMs, timeoutMs);
	if (r == kIOUSBPipeStalled) (*p->intf)->ClearPipeStallBothEnds(p->intf, p->out);
	return r;
}

// p2d_abort 中止两个端点上进行中的读写（可以在别的线程里调用）
static void p2d_abort(p2d_pipe *p) {
	(*p->intf)->AbortPipe(p->intf, p->in);
	(*p->intf)->AbortPipe(p->intf, p->out);
}

static void p2d_close(p2d_pipe *p) {
	(*p->intf)->USBInterfaceClose(p->intf);
	(*p->intf)->Release(p->intf);
	free(p);
}
*/
import "C"

import (
	"fmt"
	"os"
	"strconv"
	"sync"
	"time"
	"unsafe"
)

// Supported 这个系统能不能直接访问 USB 设备。macOS 用 IOKit，不需要 adb 和驱动。
const Supported = true

const (
	// 写入超时：对方正常时随时在读，几毫秒就写完；超时说明对方不在读了
	writeTimeoutMs = 3000
	maxADBDevices  = 32
)

// IOReturn 错误码（IOKit/IOReturn.h、IOKit/usb/USB.h）
const (
	ioReturnExclusiveAccess = 0xe00002c5
	ioReturnNotPermitted    = 0xe00002e2
	ioReturnNotPrivileged   = 0xe00002c1
	ioReturnAborted         = 0xe00002eb
	ioReturnNoDevice        = 0xe00002c0
	ioReturnTimeout         = 0xe00002d6
	ioUSBTransactionTimeout = 0xe0004051
)

func ioErr(op string, r C.int) error {
	code := uint32(r)
	switch code {
	case ioReturnExclusiveAccess:
		return ErrBusy
	case ioReturnNotPermitted, ioReturnNotPrivileged:
		return ErrPermission
	case ioReturnTimeout, ioUSBTransactionTimeout:
		return ErrTimeout
	case ioReturnAborted:
		return os.ErrClosed
	case ioReturnNoDevice:
		return fmt.Errorf("%s失败：手机已拔出", op)
	}
	return fmt.Errorf("%s失败（IOReturn 0x%08x）", op, code)
}

// ADBDevices 插着的、开了 USB 调试的设备
func ADBDevices() ([]ADBDevice, error) {
	var arr [maxADBDevices]C.p2d_adbdev
	var cnt C.int
	if kr := C.p2d_list(&arr[0], C.int(maxADBDevices), &cnt); kr != 0 {
		return nil, fmt.Errorf("枚举 USB 设备失败（kern_return 0x%x）", uint32(kr))
	}
	n := int(cnt)
	out := make([]ADBDevice, 0, n)
	for i := 0; i < n; i++ {
		d := &arr[i]
		id := uint64(d.id)
		out = append(out, ADBDevice{
			Key:     "iokit:" + strconv.FormatUint(id, 16),
			Serial:  C.GoString(&d.serial[0]),
			Product: C.GoString(&d.product[0]),
			VID:     uint16(d.vid), PID: uint16(d.pid),
			node: strconv.FormatUint(id, 10),
		})
	}
	return out, nil
}

// Open 打开 ADB 接口
func (d ADBDevice) Open() (Pipe, error) {
	id, err := strconv.ParseUint(d.node, 10, 64)
	if err != nil {
		return nil, fmt.Errorf("设备标识不对：%q", d.node)
	}
	var p *C.p2d_pipe
	if r := C.p2d_open(C.uint64_t(id), &p); r != 0 {
		if r == -1 {
			return nil, fmt.Errorf("手机的 USB 调试接口没有一对 bulk 端点")
		}
		return nil, ioErr("打开 USB 接口", r)
	}
	mp := int(p.maxPacket)
	if mp <= 0 {
		mp = 512
	}
	return &iokitPipe{p: p, maxPacket: mp}, nil
}

// iokitPipe 一对 bulk 端点。读和写各在自己的协程里同时进行；Close 先中止进行中的读写，等它们返回后再关闭接口。
type iokitPipe struct {
	p         *C.p2d_pipe
	maxPacket int
	rmu, wmu  sync.Mutex // 读、写各自串行
	life      sync.RWMutex
	closed    bool
	once      sync.Once
}

func (t *iokitPipe) Read(b []byte) (int, error) {
	t.rmu.Lock()
	defer t.rmu.Unlock()
	t.life.RLock()
	defer t.life.RUnlock()
	if t.closed {
		return 0, os.ErrClosed
	}
	if len(b) == 0 {
		return 0, nil
	}
	size := C.uint32_t(len(b))
	if r := C.p2d_read(t.p, unsafe.Pointer(&b[0]), &size); r != 0 {
		return 0, ioErr("USB 读取", r)
	}
	return int(size), nil
}

func (t *iokitPipe) writeOnce(b []byte) error {
	var ptr unsafe.Pointer
	if len(b) > 0 {
		ptr = unsafe.Pointer(&b[0])
	}
	if r := C.p2d_write(t.p, ptr, C.uint32_t(len(b)), writeTimeoutMs); r != 0 {
		return ioErr("USB 写入", r)
	}
	return nil
}

// Write 写任意长度；长度正好是包长整数倍时补一个零长度包，对方的读请求才能结束（ADB 需要）
func (t *iokitPipe) Write(b []byte) error {
	t.wmu.Lock()
	defer t.wmu.Unlock()
	t.life.RLock()
	defer t.life.RUnlock()
	if t.closed {
		return os.ErrClosed
	}
	if err := t.writeOnce(b); err != nil {
		return err
	}
	if len(b) > 0 && len(b)%t.maxPacket == 0 {
		return t.writeOnce(nil)
	}
	return nil
}

func (t *iokitPipe) Close() error {
	t.once.Do(func() {
		go func() {
			// 读请求没有超时，要中止才会返回；中止后才开始的读写也要中止，所以拿不到锁就再中止一次
			for !t.life.TryLock() {
				C.p2d_abort(t.p)
				time.Sleep(20 * time.Millisecond)
			}
			defer t.life.Unlock()
			t.closed = true
			C.p2d_close(t.p)
			t.p = nil
		}()
	})
	return nil
}
