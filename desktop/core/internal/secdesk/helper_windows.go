//go:build windows

package secdesk

import (
	"errors"
	"flag"
	"image"
	"log"
	"os"
	"runtime"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"

	"p2d/core/internal/input"
	"p2d/core/internal/screen"
)

// 锁屏助手（secure-helper）：系统服务以 SYSTEM 身份启动在用户会话里，经命名管道替电脑端在安全桌面上截屏、发键鼠。

var (
	user32                 = windows.NewLazySystemDLL("user32.dll")
	procOpenInputDesktop   = user32.NewProc("OpenInputDesktop")
	procSetThreadDesktop   = user32.NewProc("SetThreadDesktop")
	procCloseDesktop       = user32.NewProc("CloseDesktop")
	procGetUserObjectInfoW = user32.NewProc("GetUserObjectInformationW")
)

const genericAll = 0x10000000

// deskThread 所有截屏和键鼠操作都在一个固定的系统线程上做：线程先切换到当前的输入桌面（锁屏时是 Winlogon）
type deskThread struct {
	jobs chan func()
	cur  uintptr // 线程现在所在的桌面
	name string
}

func newDeskThread() *deskThread {
	t := &deskThread{jobs: make(chan func())}
	go func() {
		runtime.LockOSThread() // 不解锁：线程换过桌面，用完让它跟着 goroutine 一起结束
		for f := range t.jobs {
			t.sync()
			f()
		}
	}()
	return t
}

// run 在桌面线程上执行 f，等它做完
func (t *deskThread) run(f func()) {
	done := make(chan struct{})
	t.jobs <- func() {
		defer close(done)
		f()
	}
	<-done
}

// sync 切换到当前的输入桌面（锁屏、解锁、弹出 UAC 时输入桌面会变）
func (t *deskThread) sync() {
	h, _, _ := procOpenInputDesktop.Call(0, 0, genericAll)
	if h == 0 {
		return
	}
	if r, _, err := procSetThreadDesktop.Call(h); r == 0 {
		procCloseDesktop.Call(h)
		log.Printf("切换到输入桌面失败：%v", err)
		return
	}
	if t.cur != 0 {
		procCloseDesktop.Call(t.cur)
	}
	t.cur = h
	if n := desktopName(h); n != t.name {
		log.Printf("输入桌面：%s", n)
		t.name = n
	}
}

func desktopName(h uintptr) string {
	var buf [64]uint16
	var n uint32
	if r, _, _ := procGetUserObjectInfoW.Call(h, 2, uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)*2), uintptr(unsafe.Pointer(&n))); r == 0 {
		return ""
	}
	return syscall.UTF16ToString(buf[:])
}

// sessionUserSID 会话里登录的用户（还没人登录时返回空）
func sessionUserSID(session uint32) string {
	var tok windows.Token
	if err := windows.WTSQueryUserToken(session, &tok); err != nil {
		return ""
	}
	defer tok.Close()
	u, err := tok.GetTokenUser()
	if err != nil {
		return ""
	}
	return u.User.Sid.String()
}

func runHelper(args []string) int {
	fs := flag.NewFlagSet("secure-helper", flag.ContinueOnError)
	parent := fs.Int("parent", 0, "启动助手的服务进程，它退出时助手也退出")
	if fs.Parse(args) != nil {
		return 2
	}
	session := currentSession()
	closeLog := openLog("helper.log")
	defer closeLog()
	log.Printf("锁屏助手启动（会话 %d，版本 %d）", session, protocolVersion)
	screen.Init()

	if *parent > 0 {
		if h, err := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(*parent)); err == nil {
			go func() {
				windows.WaitForSingleObject(h, windows.INFINITE)
				log.Printf("服务已退出，锁屏助手也退出")
				os.Exit(0)
			}()
		}
	}

	// 等用户登录（开机后还在登录界面时会话里还没有用户，也就没有要连接的电脑端）
	var sid string
	for {
		if sid = sessionUserSID(session); sid != "" {
			break
		}
		time.Sleep(2 * time.Second)
	}
	// 换了用户（注销后别人在同一个会话登录）就退出，服务会重新启动助手
	go func() {
		for {
			time.Sleep(3 * time.Second)
			if now := sessionUserSID(session); now != sid {
				log.Printf("会话 %d 的登录用户变了，锁屏助手退出", session)
				os.Exit(0)
			}
		}
	}()

	sd, err := windows.SecurityDescriptorFromString(pipeSDDL(sid))
	if err != nil {
		log.Printf("管道权限设置失败：%v", err)
		return 1
	}
	sa := &windows.SecurityAttributes{Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), SecurityDescriptor: sd}
	desk := newDeskThread()
	name := pipeName(session)
	first := true
	for {
		h, err := createPipe(name, sa, first)
		if err != nil {
			if first {
				// 名字被占了：可能是上一个助手还没退出，也可能有程序在冒充，过一会儿再试
				log.Printf("创建管道失败：%v", err)
				time.Sleep(3 * time.Second)
				continue
			}
			log.Printf("创建管道失败：%v", err)
			time.Sleep(time.Second)
			continue
		}
		first = false
		if err := windows.ConnectNamedPipe(h, nil); err != nil && !errors.Is(err, windows.ERROR_PIPE_CONNECTED) {
			windows.CloseHandle(h)
			continue
		}
		go serveClient(&pipe{h: h}, session, desk)
	}
}

// serveClient 处理一个电脑端连接
func serveClient(p *pipe, session uint32, desk *deskThread) {
	defer func() {
		windows.DisconnectNamedPipe(p.h)
		p.Close()
	}()
	var pid, cs uint32
	if err := windows.GetNamedPipeClientProcessId(p.h, &pid); err != nil {
		return
	}
	if windows.ProcessIdToSessionId(pid, &cs) != nil || cs != session {
		log.Printf("拒绝连接：进程 %d 不在会话 %d", pid, session)
		return
	}
	log.Printf("电脑端已连接（进程 %d %s）", pid, processImage(pid))
	defer log.Printf("电脑端断开（进程 %d）", pid)
	for {
		var req request
		if _, err := readMsg(p, &req, nil); err != nil {
			return
		}
		var res response
		var data []byte
		switch req.Op {
		case "hello":
			res.Version = protocolVersion
			desk.run(func() { res.Desktop = desk.name })
		case "capture":
			var img *image.RGBA
			var err error
			desk.run(func() { img, err = screen.Capture(image.Rect(req.X, req.Y, req.X+req.W, req.Y+req.H)) })
			if err != nil {
				res.Error = err.Error()
				break
			}
			res.W, res.H = img.Bounds().Dx(), img.Bounds().Dy()
			data = img.Pix
		case "cursor":
			desk.run(func() { res.X, res.Y, res.OK = screen.CursorPos() })
		case "input":
			if req.Input == nil {
				res.Error = "缺少操作"
				break
			}
			var err error
			op := *req.Input
			desk.run(func() {
				if op.Kind == "text" && isASCII(op.Text) {
					err = input.TypeASCII(op.Text)
				} else {
					err = input.Do(op)
				}
			})
			if err != nil {
				res.Error = err.Error()
			}
		case "wake":
			desk.run(screen.NudgeMouse)
		default:
			res.Error = "不认识的请求：" + req.Op
		}
		if err := writeMsg(p, res, data); err != nil {
			return
		}
	}
}

func processImage(pid uint32) string {
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return ""
	}
	defer windows.CloseHandle(h)
	buf := make([]uint16, windows.MAX_LONG_PATH)
	n := uint32(len(buf))
	if windows.QueryFullProcessImageName(h, 0, &buf[0], &n) != nil {
		return ""
	}
	return windows.UTF16ToString(buf[:n])
}

func isASCII(s string) bool {
	for _, r := range s {
		if r > 0x7E {
			return false
		}
	}
	return true
}
