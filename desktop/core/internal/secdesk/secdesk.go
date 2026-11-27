// Package secdesk 锁屏远程支持（Windows）：让手机在电脑锁屏、登录界面和 UAC 确认窗口时也能看到画面、能操作。
//
// Windows 把这些界面放在单独的安全桌面（Winlogon）上，以普通用户身份运行的电脑端截不到、也操作不了。
// 用户在电脑端界面上开启后（需要管理员权限）：
//   - 把 p2d-core.exe 复制到 Program Files（只有管理员能改，防止被换成别的程序以 SYSTEM 身份运行），
//     登记成系统服务（p2d-secure-desktop，以 SYSTEM 身份运行，开机自动启动）；
//   - 服务在当前登录的用户会话里启动锁屏助手（同一个程序 secure-helper 模式，SYSTEM 身份）。
//     助手能切换到安全桌面截屏、发键盘鼠标；
//   - 电脑端（普通用户身份）发现锁屏时，经命名管道请助手代截屏、代操作。管道只允许本会话的登录用户连接、
//     拒绝网络访问；电脑端连接时检查管道属于 SYSTEM，防止别的程序冒充助手骗走输入的密码。
//
// 管道消息：4 字节小端 JSON 长度 + JSON + 4 字节小端数据长度 + 数据（截屏的像素，没有时长度为 0）。
package secdesk

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"

	"p2d/core/internal/input"
)

// protocolVersion 管道协议版本。服务不会跟着电脑端自动更新（升级电脑端不需要管理员权限），
// 改了不兼容的地方要加版本号，电脑端发现助手太旧时在界面上提示重新开启。
const protocolVersion = 1

const (
	// ServiceName 系统服务名
	ServiceName    = "p2d-secure-desktop"
	serviceDisplay = "P2D 锁屏远程支持"
	serviceDesc    = "让手机在电脑锁屏、登录界面和管理员权限确认窗口时也能看到画面、远程操作（P2D 电脑端开启）"
)

type request struct {
	Op      string    `json:"op"` // hello、capture、cursor、input、wake
	Version int       `json:"version,omitempty"`
	X       int       `json:"x,omitempty"`
	Y       int       `json:"y,omitempty"`
	W       int       `json:"w,omitempty"`
	H       int       `json:"h,omitempty"`
	Input   *input.Op `json:"input,omitempty"`
}

type response struct {
	Error   string `json:"error,omitempty"`
	Version int    `json:"version,omitempty"`
	Desktop string `json:"desktop,omitempty"` // 当前输入桌面的名字
	W       int    `json:"w,omitempty"`
	H       int    `json:"h,omitempty"`
	X       int    `json:"x,omitempty"`
	Y       int    `json:"y,omitempty"`
	OK      bool   `json:"ok,omitempty"`
}

const (
	maxJSON = 1 << 20
	maxData = 256 << 20
)

func writeMsg(w io.Writer, v any, data []byte) error {
	j, err := json.Marshal(v)
	if err != nil {
		return err
	}
	b := make([]byte, 0, 8+len(j))
	b = binary.LittleEndian.AppendUint32(b, uint32(len(j)))
	b = append(b, j...)
	b = binary.LittleEndian.AppendUint32(b, uint32(len(data)))
	if _, err := w.Write(b); err != nil {
		return err
	}
	if len(data) > 0 {
		if _, err := w.Write(data); err != nil {
			return err
		}
	}
	return nil
}

// readMsg 读一条消息；buf 够大时数据读进 buf 里（截屏的像素，复用缓冲区）
func readMsg(r io.Reader, v any, buf []byte) ([]byte, error) {
	var n [4]byte
	if _, err := io.ReadFull(r, n[:]); err != nil {
		return nil, err
	}
	jl := binary.LittleEndian.Uint32(n[:])
	if jl > maxJSON {
		return nil, errors.New("消息太长")
	}
	j := make([]byte, jl)
	if _, err := io.ReadFull(r, j); err != nil {
		return nil, err
	}
	if err := json.Unmarshal(j, v); err != nil {
		return nil, fmt.Errorf("消息格式不对：%v", err)
	}
	if _, err := io.ReadFull(r, n[:]); err != nil {
		return nil, err
	}
	dl := binary.LittleEndian.Uint32(n[:])
	if dl > maxData {
		return nil, errors.New("数据太长")
	}
	if dl == 0 {
		return nil, nil
	}
	if uint32(cap(buf)) >= dl {
		buf = buf[:dl]
	} else {
		buf = make([]byte, dl)
	}
	if _, err := io.ReadFull(r, buf); err != nil {
		return nil, err
	}
	return buf, nil
}
