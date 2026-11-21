//go:build windows

package server

import (
	"context"
	"os/exec"
	"strings"
	"time"

	"p2d/core/internal/procutil"
	"p2d/core/internal/textenc"
)

// fileSignature 用 PowerShell 的 Get-AuthenticodeSignature 检查数字签名（Win7 自带的 PowerShell 2.0 也支持）。
// 返回「状态|签名者」，如 "Valid|CN=Microsoft Windows Hardware Compatibility Publisher, ..."；无法检查时返回空字符串。
func fileSignature(path string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	p := strings.ReplaceAll(path, "'", "''")
	script := "$s = Get-AuthenticodeSignature -FilePath '" + p + "'; " +
		"$n = ''; if ($s.SignerCertificate) { $n = $s.SignerCertificate.Subject }; " +
		"Write-Output ($s.Status.ToString() + '|' + $n)"
	cmd := exec.CommandContext(ctx, "powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script)
	procutil.Prepare(cmd)
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	s, _ := textenc.Decode(out)
	return strings.TrimSpace(s)
}
