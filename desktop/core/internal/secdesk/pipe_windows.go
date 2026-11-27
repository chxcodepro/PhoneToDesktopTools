//go:build windows

package secdesk

import (
	"errors"
	"fmt"
	"strconv"

	"golang.org/x/sys/windows"
)

// pipeName 每个会话一个管道（管道名是全局的，不分会话）
func pipeName(session uint32) string {
	return `\\.\pipe\p2d-secure-desktop-` + strconv.FormatUint(uint64(session), 10)
}

// pipe 同步读写的命名管道句柄
type pipe struct{ h windows.Handle }

func (p *pipe) Read(b []byte) (int, error) {
	if len(b) > 1<<20 {
		b = b[:1<<20]
	}
	var n uint32
	if err := windows.ReadFile(p.h, b, &n, nil); err != nil {
		return int(n), err
	}
	return int(n), nil
}

func (p *pipe) Write(b []byte) (int, error) {
	total := 0
	for len(b) > 0 {
		chunk := b
		if len(chunk) > 1<<20 {
			chunk = chunk[:1<<20]
		}
		var n uint32
		if err := windows.WriteFile(p.h, chunk, &n, nil); err != nil {
			return total + int(n), err
		}
		total += int(n)
		b = b[n:]
	}
	return total, nil
}

func (p *pipe) Close() error { return windows.CloseHandle(p.h) }

// 允许登录用户做的事：读写数据、读属性和权限、等待。
// 不能给 GENERIC_WRITE：它包含 FILE_CREATE_PIPE_INSTANCE，别的程序就能再开一个同名管道实例冒充助手
const clientAccess = windows.FILE_READ_DATA | windows.FILE_WRITE_DATA | windows.FILE_READ_ATTRIBUTES |
	windows.FILE_WRITE_ATTRIBUTES | windows.READ_CONTROL | windows.SYNCHRONIZE

// pipeSDDL 管道的权限：属于 SYSTEM，SYSTEM 全部权限，登录用户只能读写数据
func pipeSDDL(userSID string) string {
	return fmt.Sprintf("O:SYG:SYD:P(A;;GA;;;SY)(A;;0x%x;;;%s)", clientAccess, userSID)
}

const (
	pipeRejectRemoteClients = 0x00000008
	pipeBuffer              = 1 << 20
)

// createPipe 助手开一个管道实例等电脑端连接。first 为 true 时要求是这个名字的第一个实例（被别人占了就失败）
func createPipe(name string, sa *windows.SecurityAttributes, first bool) (windows.Handle, error) {
	n, _ := windows.UTF16PtrFromString(name)
	mode := uint32(windows.PIPE_ACCESS_DUPLEX)
	if first {
		mode |= windows.FILE_FLAG_FIRST_PIPE_INSTANCE
	}
	return windows.CreateNamedPipe(n, mode,
		windows.PIPE_TYPE_BYTE|windows.PIPE_READMODE_BYTE|windows.PIPE_WAIT|pipeRejectRemoteClients,
		windows.PIPE_UNLIMITED_INSTANCES, pipeBuffer, pipeBuffer, 0, sa)
}

var errNotSystem = errors.New("锁屏助手的管道不属于 SYSTEM，可能被别的程序冒充，不连接")

// dialPipe 电脑端连接本会话的锁屏助手，并检查管道是 SYSTEM 建的
func dialPipe(session uint32) (*pipe, error) {
	n, _ := windows.UTF16PtrFromString(pipeName(session))
	// SECURITY_IDENTIFICATION：助手只能认出电脑端是谁，不能冒用电脑端的身份
	h, err := windows.CreateFile(n, windows.FILE_READ_DATA|windows.FILE_WRITE_DATA|windows.READ_CONTROL|windows.SYNCHRONIZE,
		0, nil, windows.OPEN_EXISTING, windows.SECURITY_SQOS_PRESENT|windows.SECURITY_IDENTIFICATION, 0)
	if err != nil {
		return nil, err
	}
	sd, err := windows.GetSecurityInfo(h, windows.SE_KERNEL_OBJECT, windows.OWNER_SECURITY_INFORMATION)
	if err != nil {
		windows.CloseHandle(h)
		return nil, fmt.Errorf("读不到锁屏助手管道的权限：%v", err)
	}
	owner, _, err := sd.Owner()
	if err != nil || owner == nil || !owner.IsWellKnown(windows.WinLocalSystemSid) {
		windows.CloseHandle(h)
		return nil, errNotSystem
	}
	return &pipe{h: h}, nil
}

// currentSession 本进程所在的会话
func currentSession() uint32 {
	var s uint32
	if windows.ProcessIdToSessionId(windows.GetCurrentProcessId(), &s) != nil {
		return 0
	}
	return s
}
