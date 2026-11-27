//go:build windows

package secdesk

import (
	"errors"
	"fmt"
	"image"
	"log"
	"sync"
	"time"

	"golang.org/x/sys/windows"

	"p2d/core/internal/input"
	"p2d/core/internal/screen"
)

// Supported 这个系统支持锁屏远程支持（只有 Windows）
const Supported = true

var errUnavailable = errors.New("锁屏助手不可用")

// client 电脑端到锁屏助手的连接（按需连接，断了下次用时再连）
type client struct {
	mu      sync.Mutex
	p       *pipe
	lastTry time.Time
	why     string // 上次连不上的原因
	version int
}

var cl client

func (c *client) connectLocked() error {
	if c.p != nil {
		return nil
	}
	if time.Since(c.lastTry) < 2*time.Second {
		return errUnavailable
	}
	c.lastTry = time.Now()
	p, err := dialPipe(currentSession())
	if err != nil {
		why := err.Error()
		if errors.Is(err, windows.ERROR_FILE_NOT_FOUND) {
			why = "锁屏助手没有运行"
		}
		if why != c.why {
			log.Printf("连不上锁屏助手：%s", why)
		}
		c.why = why
		return errUnavailable
	}
	var res response
	if err := writeMsg(p, request{Op: "hello", Version: protocolVersion}, nil); err == nil {
		_, err = readMsg(p, &res, nil)
	}
	if err != nil {
		p.Close()
		c.why = "锁屏助手没有回应：" + err.Error()
		return errUnavailable
	}
	if res.Version != protocolVersion {
		p.Close()
		c.why = fmt.Sprintf("锁屏助手版本不对（%d，需要 %d），请在电脑端重新开启锁屏远程支持", res.Version, protocolVersion)
		log.Print(c.why)
		return errUnavailable
	}
	c.p, c.why, c.version = p, "", res.Version
	log.Printf("已连接锁屏助手（输入桌面 %s）", res.Desktop)
	return nil
}

// call 发一个请求等回复；连接出错就断开，下次重连
func (c *client) call(req request) (response, []byte, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	var res response
	if err := c.connectLocked(); err != nil {
		return res, nil, err
	}
	data, err := func() ([]byte, error) {
		if err := writeMsg(c.p, req, nil); err != nil {
			return nil, err
		}
		return readMsg(c.p, &res, nil)
	}()
	if err != nil {
		c.p.Close()
		c.p = nil
		c.why = "和锁屏助手的连接断了：" + err.Error()
		log.Print(c.why)
		return res, nil, errUnavailable
	}
	if res.Error != "" {
		return res, nil, errors.New(res.Error)
	}
	return res, data, nil
}

func (c *client) ready() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.connectLocked() == nil
}

func (c *client) connected() (bool, string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.p != nil, c.why
}

func secureCapture(r image.Rectangle) (*image.RGBA, error) {
	res, data, err := cl.call(request{Op: "capture", X: r.Min.X, Y: r.Min.Y, W: r.Dx(), H: r.Dy()})
	if err != nil {
		return nil, err
	}
	if res.W <= 0 || res.H <= 0 || len(data) != res.W*res.H*4 {
		return nil, errors.New("锁屏助手返回的画面尺寸不对")
	}
	return &image.RGBA{Pix: data, Stride: res.W * 4, Rect: image.Rect(0, 0, res.W, res.H)}, nil
}

func secureCursor() (int, int, bool) {
	res, _, err := cl.call(request{Op: "cursor"})
	if err != nil {
		return 0, 0, false
	}
	return res.X, res.Y, res.OK
}

func secureInput(op input.Op) (bool, error) {
	if !screen.Locked() {
		return false, nil
	}
	_, _, err := cl.call(request{Op: "input", Input: &op})
	if errors.Is(err, errUnavailable) {
		return false, nil // 助手不可用：照常自己发（发不进去会报错）
	}
	return true, err
}

var enableOnce sync.Once

// Enable 让截屏和键鼠操作在锁屏时转给锁屏助手（电脑端启动时调用；没装服务时连不上，照常自己做）。
func Enable() {
	enableOnce.Do(func() {
		screen.SecureCapture = secureCapture
		screen.SecureCursor = secureCursor
		screen.SecureWake = func() { _, _, _ = cl.call(request{Op: "wake"}) }
		screen.SecureReady = cl.ready
		input.Secure = secureInput
	})
}

// state 给电脑端界面看的锁屏远程支持状态
type state struct {
	Supported bool   `json:"supported"`
	Installed bool   `json:"installed"` // 服务登记了
	Running   bool   `json:"running"`   // 服务在运行
	Connected bool   `json:"connected"` // 连着锁屏助手
	Problem   string `json:"problem,omitempty"`
}

var (
	statusMu    sync.Mutex
	statusCache state
	statusAt    time.Time
)

// Status 给电脑端界面看的状态（界面每秒问一次，服务状态缓存 3 秒）。
func Status() any {
	statusMu.Lock()
	defer statusMu.Unlock()
	if time.Since(statusAt) > 3*time.Second {
		statusAt = time.Now()
		statusCache = state{Supported: true}
		statusCache.Installed, statusCache.Running = queryService()
	}
	st := statusCache
	st.Connected, st.Problem = cl.connected()
	if st.Connected || !st.Running {
		st.Problem = ""
	}
	return st
}

// queryService 服务登记了没有、在不在运行（普通用户也能查）
func queryService() (installed, running bool) {
	m, err := windows.OpenSCManager(nil, nil, windows.SC_MANAGER_CONNECT)
	if err != nil {
		return false, false
	}
	defer windows.CloseServiceHandle(m)
	n, _ := windows.UTF16PtrFromString(ServiceName)
	s, err := windows.OpenService(m, n, windows.SERVICE_QUERY_STATUS)
	if err != nil {
		return false, false
	}
	defer windows.CloseServiceHandle(s)
	var ss windows.SERVICE_STATUS
	if windows.QueryServiceStatus(s, &ss) != nil {
		return true, false
	}
	return true, ss.CurrentState == windows.SERVICE_RUNNING
}

// invalidateStatus 开启 / 关闭后立即重新查服务状态
func invalidateStatus() {
	statusMu.Lock()
	statusAt = time.Time{}
	statusMu.Unlock()
	cl.mu.Lock()
	cl.lastTry = time.Time{}
	if cl.p != nil {
		cl.p.Close()
		cl.p = nil
	}
	cl.mu.Unlock()
}
