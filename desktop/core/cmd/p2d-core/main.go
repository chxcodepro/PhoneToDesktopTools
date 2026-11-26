// p2d-core：P2D 电脑端核心服务（被控端）。
// 监听 127.0.0.1，经 adb 隧道、免调试连接（AOA，Linux）或 iPhone 数据线（usbmuxd）为手机 Agent 提供 MCP 工具；局域网直连另开端口。
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
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	"p2d/core/internal/adb"
	"p2d/core/internal/aoa"
	"p2d/core/internal/iphone"
	"p2d/core/internal/lan"
	"p2d/core/internal/lanfw"
	"p2d/core/internal/portres"
	"p2d/core/internal/screen"
	"p2d/core/internal/server"
	"p2d/core/internal/tools"
	"p2d/core/internal/usbdriver"
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

// stateDir 保存记住的 WiFi 手机等状态的目录（<用户配置目录>/p2d）。
// 改名前叫 PhoneToDesktop：新目录还没有时把旧目录整个改名过来，配对记录、记住的手机都在里面。
// 和电脑端界面（Electron）的数据目录是同一个，一般已经由界面先搬好了。
func stateDir() string {
	d, err := os.UserConfigDir()
	if err != nil {
		return ""
	}
	return migrateDir(filepath.Join(d, "PhoneToDesktop"), filepath.Join(d, "p2d"))
}

// migrateDir 把改名前的目录 old 改名为 dir；dir 已存在或 old 不存在时不动。改名失败时继续用旧目录
func migrateDir(old, dir string) string {
	if _, err := os.Stat(dir); err == nil {
		return dir
	}
	if _, err := os.Stat(old); err != nil {
		return dir
	}
	if err := os.Rename(old, dir); err != nil {
		log.Printf("把 %s 改名为 %s 失败（%v），继续使用旧目录", old, dir, err)
		return old
	}
	return dir
}

func main() {
	port := flag.Int("port", 39271, "监听端口（与手机端约定，一般不改）")
	apkPath := flag.String("apk", "", "手机端安装包路径，默认 vendor/app/p2d.apk")
	pkg := flag.String("pkg", "com.p2d.mobile", "手机端包名")
	devToken := flag.String("dev-token", "", "开发调试用的固定令牌（正式使用请留空）")
	noADB := flag.Bool("no-adb", false, "不连接开了 USB 调试的手机（仅调试）")
	noAOA := flag.Bool("no-aoa", false, "不启用免调试连接（AOA 配件模式，仅 Linux）")
	noIPhone := flag.Bool("no-iphone", false, "不启用 iPhone 数据线连接（经 usbmuxd）")
	lanPort := flag.Int("lan-port", 39272, "局域网直连端口（手机输入电脑 IP 连接用），0 表示不开启")
	showVersion := flag.Bool("version", false, "显示版本")
	installDriver := flag.String("install-adb-driver", "", "（内部使用）以管理员身份安装手机 USB 驱动，结果写入指定文件")
	flag.Parse()

	if *showVersion {
		fmt.Println("p2d-core", server.Version)
		return
	}
	if *installDriver != "" {
		os.Exit(usbdriver.RunInstallCommand(*installDriver))
	}
	log.SetFlags(log.Ltime)
	screen.Init()

	host, _ := os.Hostname()
	reg := tools.NewRegistry()
	tokens := server.NewTokenStore(*devToken)
	srv := server.New(reg, tokens)
	store := lan.OpenStore(stateDir())
	srv.LAN = &server.LANConfig{Store: store, Pairing: lan.NewPairingWindow(func() {})}
	if usbdriver.Supported {
		srv.Driver = &server.ElevatedAction{
			Name: "安装手机 USB 驱动",
			Pending: func() any {
				if l := usbdriver.Missing(); len(l) > 0 {
					return l
				}
				return nil
			},
			Run: usbdriver.InstallElevated,
		}
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var mgr *adb.Manager
	if !*noADB {
		apk := *apkPath
		if apk == "" {
			apk = filepath.Join(exeDir(), "vendor", "app", "p2d.apk")
		}
		mgr = adb.New(adb.Config{
			APKPath:  apk,
			Package:  *pkg,
			Port:     *port,
			HostName: host,
			PCID:     store.PCID(),
			StateDir: stateDir(),
		}, tokens)
		mgr.OnGone = func(id string) { srv.CloseSerial(id, "手机已断开连接") }
		srv.Devices = mgr
	}

	// 免调试连接（Linux）：手机不开 USB 调试，经数据线用配件模式连接；开了调试的手机仍走 USB 调试连接
	var acc *aoa.Manager
	if aoa.Supported && !*noAOA {
		acc = aoa.New(aoa.Config{
			Port:     *port,
			HostName: host,
			PCID:     store.PCID(),
			StateDir: stateDir(),
			ADBAvailable: func() bool {
				return mgr != nil && mgr.Available()
			},
		}, tokens)
		acc.OnGone = func(id string) { srv.CloseSerial(id, "手机已断开连接") }
		srv.Accessory = acc
	}

	// iPhone 数据线连接：经系统的 usbmuxd（Mac 自带；Windows 要装「Apple 设备」或 iTunes；Linux 要装 usbmuxd）
	var iph *iphone.Manager
	if !*noIPhone {
		iph = iphone.New(iphone.Config{Port: *port, HostName: host, PCID: store.PCID()}, tokens)
		iph.OnGone = func(id string) { srv.CloseSerial(id, "iPhone 已断开连接") }
		srv.IPhones = iph
	}

	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", *port))
	if err != nil {
		if portres.Reserved(err) {
			// 界面按「被 Windows 保留」识别这一行，给出处理办法（不是「已有实例在运行」）
			log.Fatalf("无法启动：%s", portres.Hint(*port, 2))
		}
		log.Fatalf("无法监听端口 %d：%v（是否已经有一个实例在运行？）", *port, err)
	}
	httpSrv := &http.Server{Handler: srv.Handler(), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		if err := httpSrv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("服务异常退出：%v", err)
		}
	}()
	log.Printf("P2D 电脑端 %s 已启动：%s（%s/%s）", server.Version, ln.Addr(), runtime.GOOS, runtime.GOARCH)
	if *devToken != "" {
		log.Printf("开发令牌已启用：ws://127.0.0.1:%d/mcp?token=%s", *port, *devToken)
	}
	// 局域网直连：只接受配对过的手机，消息全程加密
	if *lanPort > 0 {
		lanLn, err := net.Listen("tcp", fmt.Sprintf(":%d", *lanPort))
		if err != nil {
			if portres.Reserved(err) {
				log.Printf("局域网直连未开启：%s", portres.Hint(*lanPort, 1))
			} else {
				log.Printf("局域网直连未开启：无法监听端口 %d（%v）", *lanPort, err)
			}
		} else {
			srv.LAN.Port = *lanPort
			lanSrv := &http.Server{Handler: srv.LANHandler(), ReadHeaderTimeout: 10 * time.Second}
			go func() { _ = lanSrv.Serve(lanLn) }()
			log.Printf("局域网直连已开启：端口 %d，本机地址 %s", *lanPort, strings.Join(lan.Addrs(), "、"))
			if lanfw.Supported {
				port := *lanPort
				srv.Firewall = &server.ElevatedAction{
					Name: "放行防火墙",
					Pending: func() any {
						if lanfw.Blocked(port) {
							return true
						}
						return nil
					},
					Run: func() error { return lanfw.Allow(port) },
				}
				if lanfw.Blocked(port) {
					log.Printf("系统防火墙会挡住手机通过 WiFi 连接（端口 %d），可以在电脑端界面上点「放行」", port)
				}
			}
		}
	}
	if mgr != nil {
		go mgr.Run(ctx)
		log.Printf("等待手机通过数据线连接…")
	}
	if acc != nil {
		go acc.Run(ctx)
		log.Printf("免调试连接已开启：没开 USB 调试的手机也能用数据线连接")
	}
	if iph != nil {
		go iph.Run(ctx)
	}

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	<-sig
	log.Printf("正在退出…")
	cancel()
	srv.DisconnectAll()
	srv.StopAllMCP()
	if mgr != nil {
		mgr.RemoveReverses()
	}
	shutdownCtx, c2 := context.WithTimeout(context.Background(), 3*time.Second)
	defer c2()
	_ = httpSrv.Shutdown(shutdownCtx)
}
