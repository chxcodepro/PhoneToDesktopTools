package lan

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"strings"
)

// 电脑标识的来源。
//
// 早期版本的电脑标识（pcId）是第一次启动时随机生成、存在 lan.json 里的。lan.json 的实际位置
// 会随启动方式变化：例如从 MSIX 打包的程序（Claude 桌面版等）里启动时，写 %APPDATA% 会被
// 系统重定向到该程序自己的 Packages\…\LocalCache 目录；换了用户、sudo 运行、删掉配置目录也一样。
// 读不到原来的 lan.json 就会生成新的随机标识，手机端于是多出一条「同一台电脑」的记录。
//
// 现在：
//   - 新生成的 pcId 由本机系统标识（Windows MachineGuid / Linux machine-id）加主机名派生，
//     不管 lan.json 存在哪、丢没丢，同一台电脑总能得到同一个 pcId；
//   - 另外给手机一个机器指纹 mid（同样派生，但用不同的盐），手机端据此把 pcId 不同、
//     实际是同一台电脑的旧记录合并掉（兼容已经产生的重复记录，以及 lan.json 里已有的随机 pcId）。
//
// 已经存在的 pcId 保持不变（手机上的配对密钥按 pcId 保存，改了会让 WiFi 直连失效）。

// machineSeed 本机系统标识，取不到时为空（测试里会替换）。
var machineSeed = func() string { return strings.TrimSpace(systemMachineID()) }

// hostName 主机名（测试里会替换）。
var hostName = func() string {
	h, _ := os.Hostname()
	return h
}

// deriveID 由系统标识和主机名派生出的标识；系统标识取不到时返回空。
// 加上主机名是为了区分直接克隆系统（Ghost 等）而 MachineGuid 相同的电脑。
func deriveID(salt string, n int) string {
	seed := machineSeed()
	if seed == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(salt + "\x00" + strings.ToLower(seed) + "\x00" + strings.ToLower(strings.TrimSpace(hostName()))))
	return hex.EncodeToString(sum[:n])
}

// derivedPCID 新建状态文件时使用的 pcId（16 位十六进制，与旧的随机标识格式相同）。
func derivedPCID() string { return deriveID("p2d pc id v1", 8) }

// MachineID 机器指纹：同一台电脑（同系统、同主机名）不管从哪启动、lan.json 是否丢失都相同。
// 手机端用它识别「pcId 变了但其实是同一台电脑」的旧记录。取不到时为空。
func MachineID() string { return deriveID("p2d machine v1", 8) }
