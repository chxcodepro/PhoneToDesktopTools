//go:build windows

package secdesk

import (
	"context"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
)

// 系统服务（secure-service）：以 SYSTEM 身份运行，在当前登录到这台电脑屏幕前的会话（控制台会话）里启动锁屏助手，
// 助手退出了就重新启动，换了会话（切换用户、注销后重新登录）就把助手换过去。

// RunCommand 处理内部命令：secure-service（服务）、secure-helper（助手）、secure-setup（提权后开启 / 关闭）、
// secure-disable（卸载电脑端时关闭）。
// 不是这几个命令时返回 false。
func RunCommand(args []string) (int, bool) {
	if len(args) == 0 {
		return 0, false
	}
	switch args[0] {
	case "secure-service":
		return runService(), true
	case "secure-helper":
		return runHelper(args[1:]), true
	case "secure-setup":
		return runSetup(args[1:]), true
	case "secure-disable":
		// 卸载电脑端时调用（普通用户身份）：弹出提权窗口关闭锁屏远程支持
		if installed, _ := queryService(); !installed {
			return 0, true
		}
		if err := Uninstall(); err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1, true
		}
		return 0, true
	}
	return 0, false
}

// serviceDir 服务程序所在的目录（Program Files 下，只有管理员能改）
func serviceDir() string {
	pf, err := windows.KnownFolderPath(windows.FOLDERID_ProgramFiles, 0)
	if err != nil || pf == "" {
		pf = os.Getenv("ProgramFiles")
	}
	return filepath.Join(pf, "P2D", "secure-desktop")
}

func serviceExe() string { return filepath.Join(serviceDir(), "p2d-service.exe") }

// openLog 服务和助手的日志写在服务目录的 logs 下（超过 1 MB 就清空重写）
func openLog(name string) func() {
	exe, err := os.Executable()
	if err != nil {
		return func() {}
	}
	dir := filepath.Join(filepath.Dir(exe), "logs")
	if os.MkdirAll(dir, 0o755) != nil {
		return func() {}
	}
	p := filepath.Join(dir, name)
	flags := os.O_CREATE | os.O_WRONLY | os.O_APPEND
	if fi, err := os.Stat(p); err == nil && fi.Size() > 1<<20 {
		flags = os.O_CREATE | os.O_WRONLY | os.O_TRUNC
	}
	f, err := os.OpenFile(p, flags, 0o644)
	if err != nil {
		return func() {}
	}
	log.SetOutput(f)
	log.SetFlags(log.LstdFlags)
	return func() { f.Close() }
}

type service struct{}

func runService() int {
	closeLog := openLog("service.log")
	defer closeLog()
	if ok, err := svc.IsWindowsService(); err != nil || !ok {
		log.Printf("secure-service 只能由系统服务管理器启动")
		fmt.Fprintln(os.Stderr, "secure-service 只能由系统服务管理器启动")
		return 2
	}
	if err := svc.Run(ServiceName, service{}); err != nil {
		log.Printf("服务运行失败：%v", err)
		return 1
	}
	return 0
}

func (service) Execute(args []string, r <-chan svc.ChangeRequest, s chan<- svc.Status) (bool, uint32) {
	s <- svc.Status{State: svc.StartPending}
	log.Printf("锁屏远程支持服务启动（版本 %d）", protocolVersion)
	ctx, cancel := context.WithCancel(context.Background())
	poke := make(chan struct{}, 1)
	done := make(chan struct{})
	go func() {
		supervise(ctx, poke)
		close(done)
	}()
	s <- svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown | svc.AcceptSessionChange}
	for c := range r {
		switch c.Cmd {
		case svc.Interrogate:
			s <- c.CurrentStatus
		case svc.SessionChange:
			select {
			case poke <- struct{}{}:
			default:
			}
		case svc.Stop, svc.Shutdown:
			s <- svc.Status{State: svc.StopPending}
			cancel()
			<-done
			log.Printf("锁屏远程支持服务停止")
			return false, 0
		}
	}
	cancel()
	<-done
	return false, 0
}

type helperProc struct {
	session uint32
	proc    windows.Handle
}

func (h *helperProc) exited() bool {
	ev, _ := windows.WaitForSingleObject(h.proc, 0)
	return ev == windows.WAIT_OBJECT_0
}

func (h *helperProc) stop() {
	if !h.exited() {
		windows.TerminateProcess(h.proc, 0)
		windows.WaitForSingleObject(h.proc, 3000)
	}
	windows.CloseHandle(h.proc)
}

const noSession = 0xFFFFFFFF

// supervise 保持控制台会话里有一个锁屏助手在运行
func supervise(ctx context.Context, poke <-chan struct{}) {
	var cur *helperProc
	var lastStart time.Time
	failures := 0
	for {
		sid := windows.WTSGetActiveConsoleSessionId()
		if cur != nil && (cur.session != sid || cur.exited()) {
			if cur.exited() {
				var code uint32
				windows.GetExitCodeProcess(cur.proc, &code)
				log.Printf("会话 %d 的锁屏助手退出了（%d）", cur.session, code)
			} else {
				log.Printf("控制台会话从 %d 换到 %d，重新启动锁屏助手", cur.session, sid)
			}
			cur.stop()
			cur = nil
		}
		// 连续失败时等久一点再试，免得一直刷日志
		wait := 2 * time.Second
		if failures > 3 {
			wait = 30 * time.Second
		}
		if cur == nil && sid != noSession && sid != 0 && time.Since(lastStart) >= wait {
			lastStart = time.Now()
			h, err := startHelper(sid)
			if err != nil {
				failures++
				log.Printf("在会话 %d 启动锁屏助手失败：%v", sid, err)
			} else {
				failures = 0
				cur = h
				log.Printf("已在会话 %d 启动锁屏助手", sid)
			}
		}
		select {
		case <-ctx.Done():
			if cur != nil {
				cur.stop()
			}
			return
		case <-poke:
			time.Sleep(300 * time.Millisecond) // 会话切换的通知比会话真正就绪早一点
		case <-time.After(2 * time.Second):
		}
	}
}

// startHelper 用服务自己的 SYSTEM 令牌（改成目标会话）在会话里启动助手，放在 winsta0\default 窗口站上
func startHelper(session uint32) (*helperProc, error) {
	exe, err := os.Executable()
	if err != nil {
		return nil, err
	}
	var tok windows.Token
	if err := windows.OpenProcessToken(windows.CurrentProcess(),
		windows.TOKEN_DUPLICATE|windows.TOKEN_QUERY|windows.TOKEN_ASSIGN_PRIMARY|windows.TOKEN_ADJUST_DEFAULT|windows.TOKEN_ADJUST_SESSIONID, &tok); err != nil {
		return nil, fmt.Errorf("打开服务令牌失败：%v", err)
	}
	defer tok.Close()
	var dup windows.Token
	if err := windows.DuplicateTokenEx(tok, windows.MAXIMUM_ALLOWED, nil, windows.SecurityImpersonation, windows.TokenPrimary, &dup); err != nil {
		return nil, fmt.Errorf("复制令牌失败：%v", err)
	}
	defer dup.Close()
	if err := windows.SetTokenInformation(dup, windows.TokenSessionId, (*byte)(unsafe.Pointer(&session)), 4); err != nil {
		return nil, fmt.Errorf("设置令牌会话失败：%v", err)
	}
	cmd := syscall.EscapeArg(exe) + " secure-helper -parent " + strconv.Itoa(int(windows.GetCurrentProcessId()))
	cmdLine, _ := windows.UTF16PtrFromString(cmd)
	desktop, _ := windows.UTF16PtrFromString(`winsta0\default`)
	dir, _ := windows.UTF16PtrFromString(filepath.Dir(exe))
	si := windows.StartupInfo{Desktop: desktop}
	si.Cb = uint32(unsafe.Sizeof(si))
	var pi windows.ProcessInformation
	if err := windows.CreateProcessAsUser(dup, nil, cmdLine, nil, nil, false,
		windows.CREATE_NO_WINDOW|windows.CREATE_UNICODE_ENVIRONMENT, nil, dir, &si, &pi); err != nil {
		return nil, fmt.Errorf("CreateProcessAsUser 失败：%v", err)
	}
	windows.CloseHandle(pi.Thread)
	return &helperProc{session: session, proc: pi.Process}, nil
}
