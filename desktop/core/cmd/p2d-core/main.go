// p2d-core：PhoneToDesktop 电脑端核心服务（被控端）。
// 监听 127.0.0.1，经 USB 隧道为手机 Agent 提供 MCP 工具。
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"syscall"
	"time"

	"p2d/core/internal/adb"
	"p2d/core/internal/screen"
	"p2d/core/internal/server"
	"p2d/core/internal/tools"
)

func exeDir() string {
	p, err := os.Executable()
	if err != nil {
		return "."
	}
	if r, err := filepath.EvalSymlinks(p); err == nil {
		p = r
	}
	return filepath.Dir(p)
}

// findADB 优先使用程序目录内置的 adb，其次是 PATH 中的 adb（开发环境）。
func findADB(flagVal string) string {
	if flagVal != "" {
		return flagVal
	}
	name := "adb"
	if runtime.GOOS == "windows" {
		name = "adb.exe"
	}
	bundled := filepath.Join(exeDir(), "vendor", "adb", name)
	if _, err := os.Stat(bundled); err == nil {
		return bundled
	}
	if p, err := exec.LookPath(name); err == nil {
		return p
	}
	return bundled
}

func main() {
	port := flag.Int("port", 39271, "监听端口（与手机端约定，一般不改）")
	adbPath := flag.String("adb", "", "adb 路径，默认使用程序目录下 vendor/adb 中的内置 adb")
	apkPath := flag.String("apk", "", "手机端安装包路径，默认 vendor/app/p2d.apk")
	pkg := flag.String("pkg", "com.p2d.mobile", "手机端包名")
	devToken := flag.String("dev-token", "", "开发调试用的固定令牌（正式使用请留空）")
	noADB := flag.Bool("no-adb", false, "不启动 adb 设备发现（仅调试）")
	showVersion := flag.Bool("version", false, "显示版本")
	flag.Parse()

	if *showVersion {
		fmt.Println("p2d-core", server.Version)
		return
	}
	log.SetFlags(log.Ltime)
	screen.Init()

	host, _ := os.Hostname()
	reg := tools.NewRegistry()
	tokens := server.NewTokenStore(*devToken)
	srv := server.New(reg, tokens)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var mgr *adb.Manager
	if !*noADB {
		apk := *apkPath
		if apk == "" {
			apk = filepath.Join(exeDir(), "vendor", "app", "p2d.apk")
		}
		mgr = adb.New(adb.Config{
			ADBPath:  findADB(*adbPath),
			APKPath:  apk,
			Package:  *pkg,
			Port:     *port,
			HostName: host,
		}, tokens)
		mgr.OnGone = func(serial string) { srv.CloseSerial(serial, "数据线已拔出") }
		srv.Devices = mgr
		log.Printf("adb：%s", findADB(*adbPath))
	}

	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", *port))
	if err != nil {
		log.Fatalf("无法监听端口 %d：%v（是否已经有一个实例在运行？）", *port, err)
	}
	httpSrv := &http.Server{Handler: srv.Handler(), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		if err := httpSrv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("服务异常退出：%v", err)
		}
	}()
	log.Printf("PhoneToDesktop 电脑端 %s 已启动：%s（%s/%s）", server.Version, ln.Addr(), runtime.GOOS, runtime.GOARCH)
	if *devToken != "" {
		log.Printf("开发令牌已启用：ws://127.0.0.1:%d/mcp?token=%s", *port, *devToken)
	}
	if mgr != nil {
		go mgr.Run(ctx)
		log.Printf("等待手机通过数据线连接…")
	}

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	<-sig
	log.Printf("正在退出…")
	cancel()
	srv.DisconnectAll()
	if mgr != nil {
		mgr.RemoveReverses()
	}
	shutdownCtx, c2 := context.WithTimeout(context.Background(), 3*time.Second)
	defer c2()
	_ = httpSrv.Shutdown(shutdownCtx)
}
