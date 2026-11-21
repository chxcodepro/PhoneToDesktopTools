//go:build !windows

package server

// fileSignature 只在 Windows 上检查 Authenticode 签名；Linux 软件包的校验由 dpkg / apt 完成。
func fileSignature(string) string { return "" }
