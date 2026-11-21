package server

// 手机向电脑上传文件（用户在 Agent 对话里添加的附件，或 Agent 用手机网络下载的驱动 / 安装包）：
//   p2d/upload.begin  { name, size }      → { id, path }   在「下载/PhoneToDesktop」下创建文件
//   p2d/upload.chunk  { id, data(base64) } → { written }   按顺序追加（dispatch 在读循环中同步执行，天然有序）
//   p2d/upload.end    { id, verify? }      → { path, size, sha256, sha1, signature? }
//                                            校验大小后完成；verify 为 true 时在 Windows 上检查数字签名
//   p2d/upload.cancel { id }                               删除未完成的文件
// 连接断开时，未完成的上传会被删除。

import (
	"bufio"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"hash"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"

	"p2d/core/internal/perm"
)

const maxUploadSize = 1 << 30 // 1 GB

type upload struct {
	f       *os.File
	path    string
	size    int64
	written int64
	// 边写边算哈希，供 Agent 核对下载文件（微软更新目录提供的是 SHA-1）
	sha256 hash.Hash
	sha1   hash.Hash
}

type uploadState struct {
	mu    sync.Mutex
	seq   int
	files map[string]*upload
}

// UploadDir 上传文件的保存目录：系统「下载」目录下的 PhoneToDesktop。可用环境变量 P2D_UPLOAD_DIR 覆盖。
func UploadDir() string {
	if d := os.Getenv("P2D_UPLOAD_DIR"); d != "" {
		return d
	}
	home, err := os.UserHomeDir()
	if err != nil {
		home = os.TempDir()
	}
	return filepath.Join(downloadsDir(home), "PhoneToDesktop")
}

func downloadsDir(home string) string {
	if runtime.GOOS != "windows" {
		// 麒麟等中文桌面的「下载」目录记录在 user-dirs.dirs 中，如 XDG_DOWNLOAD_DIR="$HOME/下载"
		if d := xdgDownloadDir(home); d != "" {
			return d
		}
		if isDir(filepath.Join(home, "下载")) {
			return filepath.Join(home, "下载")
		}
	}
	return filepath.Join(home, "Downloads")
}

func xdgDownloadDir(home string) string {
	f, err := os.Open(filepath.Join(home, ".config", "user-dirs.dirs"))
	if err != nil {
		return ""
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		v, ok := strings.CutPrefix(line, "XDG_DOWNLOAD_DIR=")
		if !ok {
			continue
		}
		v = strings.Trim(v, `"`)
		v = strings.Replace(v, "$HOME", home, 1)
		if filepath.IsAbs(v) && v != home {
			return v
		}
	}
	return ""
}

func isDir(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.IsDir()
}

// safeFileName 去掉路径和系统不允许的字符。
func safeFileName(name string) string {
	name = filepath.Base(strings.ReplaceAll(name, "\\", "/"))
	name = strings.Map(func(r rune) rune {
		if r < 32 || strings.ContainsRune(`<>:"/\|?*`, r) {
			return '_'
		}
		return r
	}, name)
	name = strings.TrimRight(strings.TrimSpace(name), ". ")
	if name == "" || name == "." || name == ".." {
		name = "文件"
	}
	return name
}

// createUnique 创建不重名的文件：同名时加「 (1)」「 (2)」…
func createUnique(dir, name string) (*os.File, string, error) {
	ext := filepath.Ext(name)
	stem := strings.TrimSuffix(name, ext)
	for i := 0; i < 1000; i++ {
		n := name
		if i > 0 {
			n = stem + " (" + strconv.Itoa(i) + ")" + ext
		}
		p := filepath.Join(dir, n)
		f, err := os.OpenFile(p, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
		if err == nil {
			return f, p, nil
		}
		if !os.IsExist(err) {
			return nil, "", err
		}
	}
	return nil, "", fmt.Errorf("同名文件太多：%s", name)
}

func (s *Session) uploadBegin(params json.RawMessage) (any, error) {
	var p struct {
		Name string `json:"name"`
		Size int64  `json:"size"`
	}
	if err := json.Unmarshal(params, &p); err != nil || p.Name == "" {
		return nil, fmt.Errorf("需要文件名 name 和大小 size")
	}
	if p.Size < 0 || p.Size > maxUploadSize {
		return nil, fmt.Errorf("文件太大（最大 1 GB）")
	}
	if ok, why := s.Info().Permissions.Allow(perm.CatFS, perm.Write); !ok {
		return nil, fmt.Errorf("%s", why)
	}
	dir := UploadDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("无法创建目录 %s：%v", dir, err)
	}
	f, path, err := createUnique(dir, safeFileName(p.Name))
	if err != nil {
		return nil, fmt.Errorf("无法创建文件：%v", err)
	}
	u := &s.uploads
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.files == nil {
		u.files = map[string]*upload{}
	}
	u.seq++
	id := strconv.Itoa(u.seq)
	u.files[id] = &upload{f: f, path: path, size: p.Size, sha256: sha256.New(), sha1: sha1.New()}
	return map[string]any{"id": id, "path": path}, nil
}

func (s *Session) uploadGet(params json.RawMessage) (*upload, string, json.RawMessage, error) {
	var p struct {
		ID   string          `json:"id"`
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(params, &p); err != nil || p.ID == "" {
		return nil, "", nil, fmt.Errorf("需要上传编号 id")
	}
	s.uploads.mu.Lock()
	up := s.uploads.files[p.ID]
	s.uploads.mu.Unlock()
	if up == nil {
		return nil, "", nil, fmt.Errorf("上传不存在或已结束：%s", p.ID)
	}
	return up, p.ID, p.Data, nil
}

func (s *Session) uploadChunk(params json.RawMessage) (any, error) {
	up, id, raw, err := s.uploadGet(params)
	if err != nil {
		return nil, err
	}
	var b64 string
	if err := json.Unmarshal(raw, &b64); err != nil {
		return nil, fmt.Errorf("data 需要是 base64 字符串")
	}
	data, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return nil, fmt.Errorf("data 不是合法的 base64")
	}
	if up.written+int64(len(data)) > up.size {
		s.uploadDrop(id)
		return nil, fmt.Errorf("数据超过声明的文件大小")
	}
	if _, err := up.f.Write(data); err != nil {
		s.uploadDrop(id)
		return nil, fmt.Errorf("写入失败：%v", err)
	}
	up.written += int64(len(data))
	up.sha256.Write(data)
	up.sha1.Write(data)
	return map[string]any{"written": up.written}, nil
}

func (s *Session) uploadEnd(params json.RawMessage) (any, error) {
	up, id, _, err := s.uploadGet(params)
	if err != nil {
		return nil, err
	}
	var opt struct {
		Verify bool `json:"verify"`
	}
	_ = json.Unmarshal(params, &opt)
	if up.written != up.size {
		s.uploadDrop(id)
		return nil, fmt.Errorf("文件不完整（收到 %d / %d 字节）", up.written, up.size)
	}
	s.uploads.mu.Lock()
	delete(s.uploads.files, id)
	s.uploads.mu.Unlock()
	if err := up.f.Close(); err != nil {
		_ = os.Remove(up.path)
		return nil, fmt.Errorf("保存失败：%v", err)
	}
	out := map[string]any{
		"path":   up.path,
		"size":   up.size,
		"sha256": hex.EncodeToString(up.sha256.Sum(nil)),
		"sha1":   hex.EncodeToString(up.sha1.Sum(nil)),
	}
	if opt.Verify {
		if sig := fileSignature(up.path); sig != "" {
			out["signature"] = sig
		}
	}
	return out, nil
}

func (s *Session) uploadCancel(params json.RawMessage) (any, error) {
	_, id, _, err := s.uploadGet(params)
	if err != nil {
		return nil, err
	}
	s.uploadDrop(id)
	return nil, nil
}

// uploadDrop 关闭并删除未完成的上传。
func (s *Session) uploadDrop(id string) {
	s.uploads.mu.Lock()
	up := s.uploads.files[id]
	delete(s.uploads.files, id)
	s.uploads.mu.Unlock()
	if up != nil {
		_ = up.f.Close()
		_ = os.Remove(up.path)
	}
}

// uploadDropAll 连接断开时清理所有未完成的上传。
func (s *Session) uploadDropAll() {
	s.uploads.mu.Lock()
	ids := make([]string, 0, len(s.uploads.files))
	for id := range s.uploads.files {
		ids = append(ids, id)
	}
	s.uploads.mu.Unlock()
	for _, id := range ids {
		s.uploadDrop(id)
	}
}
