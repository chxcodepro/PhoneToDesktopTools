package lan

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"sync"
	"time"
)

// PairingWindow 用户在电脑上点「配对新手机」后打开的配对窗口：限时、一次只配一台。
type PairingWindow struct {
	mu        sync.Mutex
	active    bool
	expires   time.Time
	secret    []byte // 二维码里的一次性密钥
	busy      bool   // 有手机正在配对
	state     string // waiting / code / done
	code      string // 配对码模式下电脑显示的 6 位码
	phoneName string
	onChange  func()
}

// PairingInfo 给界面的状态。
type PairingInfo struct {
	Active    bool      `json:"active"`
	ExpiresAt time.Time `json:"expiresAt,omitempty"`
	State     string    `json:"state,omitempty"`
	Code      string    `json:"code,omitempty"`
	PhoneName string    `json:"phoneName,omitempty"`
	Secret    string    `json:"-"`
}

func NewPairingWindow(onChange func()) *PairingWindow {
	return &PairingWindow{onChange: onChange}
}

func (w *PairingWindow) changed() {
	if w.onChange != nil {
		go w.onChange()
	}
}

// Start 打开配对窗口（重复打开会换新的密钥）。
func (w *PairingWindow) Start(d time.Duration) {
	w.mu.Lock()
	w.active = true
	w.expires = time.Now().Add(d)
	w.secret = Random(rand.Reader, 16)
	w.busy = false
	w.state = "waiting"
	w.code = ""
	w.phoneName = ""
	w.mu.Unlock()
	w.changed()
}

// Cancel 关闭配对窗口。
func (w *PairingWindow) Cancel() {
	w.mu.Lock()
	w.active = false
	w.busy = false
	w.mu.Unlock()
	w.changed()
}

func (w *PairingWindow) expiredLocked() bool {
	if w.active && time.Now().After(w.expires) {
		w.active = false
		w.busy = false
	}
	return !w.active
}

// Info 当前状态。
func (w *PairingWindow) Info() PairingInfo {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.expiredLocked() && w.state != "done" {
		return PairingInfo{}
	}
	if !w.active && w.state == "done" {
		// 刚配对成功：保留结果给界面显示，直到下次打开
		return PairingInfo{State: "done", PhoneName: w.phoneName}
	}
	return PairingInfo{
		Active: w.active, ExpiresAt: w.expires, State: w.state, Code: w.code, PhoneName: w.phoneName,
		Secret: base64.RawURLEncoding.EncodeToString(w.secret),
	}
}

// ErrNotOpen 电脑上没有打开配对窗口。
var ErrNotOpen = errors.New("电脑上没有打开「配对新手机」，请先在电脑端窗口里点「配对新手机」")

// ErrBusy 已经有手机在配对。
var ErrBusy = errors.New("另一台手机正在配对，请稍后再试")

// Begin 一台手机开始配对；返回二维码密钥（扫码模式用来校验）。
func (w *PairingWindow) Begin() ([]byte, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.expiredLocked() {
		return nil, ErrNotOpen
	}
	if w.busy {
		return nil, ErrBusy
	}
	w.busy = true
	return append([]byte{}, w.secret...), nil
}

// ShowCode 配对码模式：在电脑上显示 6 位码。
func (w *PairingWindow) ShowCode(code, phoneName string) {
	w.mu.Lock()
	w.state = "code"
	w.code = code
	w.phoneName = phoneName
	w.mu.Unlock()
	w.changed()
}

// Finish 配对结束；ok 为 true 时关闭窗口。
func (w *PairingWindow) Finish(ok bool, phoneName string) {
	w.mu.Lock()
	w.busy = false
	w.code = ""
	if ok {
		w.active = false
		w.state = "done"
		w.phoneName = phoneName
	} else if w.active {
		w.state = "waiting"
		w.phoneName = ""
	}
	w.mu.Unlock()
	w.changed()
}
