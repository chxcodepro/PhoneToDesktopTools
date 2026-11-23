package adb

// 手机端自动更新：电脑端内置的安装包和手机上已装的不一样时，插线连接时覆盖安装。
// 不比较版本号，直接比较安装包的 SHA-256：开发中重新打包（版本号没变）也能更新。
// 手机上装的是更新的版本时，adb 会以「版本降级」拒绝安装，此时继续使用手机上的版本。
// 被拒绝过的组合（手机上的包 + 内置的包）记下来，之后插线不再重复推送安装包（推一次要十几秒）。

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"log"
	"os"
	"strings"
	"sync"
	"time"
)

// apkCache 内置安装包的 SHA-256，文件变了（大小或修改时间）才重新计算。
type apkCache struct {
	mu   sync.Mutex
	size int64
	mod  time.Time
	sum  string
}

func (c *apkCache) hash(path string) (string, error) {
	st, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.sum != "" && c.size == st.Size() && c.mod.Equal(st.ModTime()) {
		return c.sum, nil
	}
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	c.size, c.mod, c.sum = st.Size(), st.ModTime(), hex.EncodeToString(h.Sum(nil))
	return c.sum, nil
}

// installedAPKPath 从 `pm path` 的输出里取主安装包路径（拆分安装时有多行，取 base.apk）。
func installedAPKPath(pmOut string) string {
	first := ""
	for _, line := range strings.Split(pmOut, "\n") {
		p := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(line), "package:"))
		if p == "" || !strings.HasPrefix(p, "/") {
			continue
		}
		if strings.HasSuffix(p, "/base.apk") {
			return p
		}
		if first == "" {
			first = p
		}
	}
	return first
}

// rejectedUpdates 被手机拒绝过的更新：键是「手机上的包哈希|内置包哈希」
type rejectedUpdates struct {
	mu   sync.Mutex
	keys map[string]bool
}

func (r *rejectedUpdates) has(key string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.keys[key]
}

func (r *rejectedUpdates) add(key string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.keys == nil {
		r.keys = map[string]bool{}
	}
	r.keys[key] = true
}

// needsUpdate 手机上已装的 App 和内置安装包是否不同。取不到哈希（如手机没有 sha256sum）时不更新。
// 返回的 key 交给 updateApp，更新被拒绝时记下来。
func (m *Manager) needsUpdate(ctx context.Context, serial, pmOut string) (bool, string) {
	if m.cfg.APKPath == "" || !fileExists(m.cfg.APKPath) {
		return false, ""
	}
	local, err := m.apk.hash(m.cfg.APKPath)
	if err != nil {
		return false, ""
	}
	path := installedAPKPath(pmOut)
	if path == "" {
		return false, ""
	}
	out, err := m.run(ctx, 30*time.Second, "-s", serial, "shell", "sha256sum", "'"+path+"'")
	if err != nil {
		return false, ""
	}
	fields := strings.Fields(out)
	if len(fields) == 0 || len(fields[0]) != 64 {
		return false, ""
	}
	remote := strings.ToLower(fields[0])
	if remote == strings.ToLower(local) {
		return false, ""
	}
	key := remote + "|" + strings.ToLower(local)
	if m.rejected.has(key) {
		return false, ""
	}
	return true, key
}

// updateApp 覆盖安装内置安装包。返回是否真的装上了（装上后 App 会被系统结束，需要重新拉起）。
// 失败不影响连接：继续使用手机上已有的版本。
func (m *Manager) updateApp(ctx context.Context, serial, key string) bool {
	m.setStage(serial, StageInstalling, "正在更新手机端，部分手机需要在手机上点「允许安装」")
	log.Printf("设备 %s：手机端版本和电脑端内置的不同，正在更新", serial)
	out, err := m.run(ctx, 3*time.Minute, "-s", serial, "install", "-r", m.cfg.APKPath)
	switch {
	case err == nil && strings.Contains(out, "Success"):
		log.Printf("设备 %s：手机端已更新", serial)
		return true
	case strings.Contains(out, "VERSION_DOWNGRADE"):
		m.rejected.add(key)
		log.Printf("设备 %s：手机上的版本比电脑端内置的新，不更新", serial)
	case strings.Contains(out, "UPDATE_INCOMPATIBLE"):
		m.rejected.add(key)
		log.Printf("设备 %s：手机上的 App 签名不同（可能是开发版），不更新；如需更新请先在手机上卸载", serial)
	default:
		log.Printf("设备 %s：更新手机端失败，继续使用手机上的版本：%v %s", serial, err, out)
	}
	return false
}
