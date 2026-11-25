package server

// 扩展相关的自定义方法（docs/PROTOCOL.md 第 8 节）：
// - p2d/skill.has / p2d/skill.sync：把手机上的 Skill 文件同步到电脑缓存目录（按内容哈希，只传一次），脚本由 shell_exec 执行；
// - p2d/mcp.start / p2d/mcp.call / p2d/mcp.stop：在电脑上运行 stdio MCP 服务并转发调用。

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"p2d/core/internal/perm"
	"p2d/core/internal/stdiomcp"
)

// 同步一个 Skill 的上限
const maxSkillBytes = 32 << 20

var hashRe = regexp.MustCompile(`^[0-9a-f]{8,64}$`)

// SkillCacheDir Skill 文件在电脑上的缓存目录。可用环境变量 P2D_SKILL_DIR 覆盖。
func SkillCacheDir() string {
	if d := os.Getenv("P2D_SKILL_DIR"); d != "" {
		return d
	}
	d, err := os.UserCacheDir()
	if err != nil {
		d = os.TempDir()
	}
	return filepath.Join(d, "p2d", "skills")
}

func skillDir(name, hash string) string {
	n := strings.TrimSpace(safeFileName(name))
	if n == "" || n == "." {
		n = "skill"
	}
	if len(hash) > 16 {
		hash = hash[:16]
	}
	return filepath.Join(SkillCacheDir(), n+"-"+hash)
}

const completeMarker = ".p2d-complete"

func (s *Session) skillHas(raw json.RawMessage) (any, error) {
	var p struct {
		Name string `json:"name"`
		Hash string `json:"hash"`
	}
	if err := json.Unmarshal(raw, &p); err != nil || !hashRe.MatchString(p.Hash) {
		return nil, errors.New("需要 name 和 hash")
	}
	dir := skillDir(p.Name, p.Hash)
	_, err := os.Stat(filepath.Join(dir, completeMarker))
	return map[string]any{"dir": dir, "exists": err == nil}, nil
}

// safeJoin 把相对路径拼到 dir 下，拒绝绝对路径和 ..
func safeJoin(dir, rel string) (string, error) {
	rel = strings.ReplaceAll(rel, "\\", "/")
	// 含冒号的（盘符、Windows 备用数据流）在所有平台都拒绝，行为一致
	if rel == "" || strings.HasPrefix(rel, "/") || strings.Contains(rel, ":") || filepath.IsAbs(rel) || filepath.VolumeName(rel) != "" {
		return "", fmt.Errorf("文件路径不合法：%s", rel)
	}
	for _, part := range strings.Split(rel, "/") {
		if part == ".." {
			return "", fmt.Errorf("文件路径不合法：%s", rel)
		}
	}
	p := filepath.Join(dir, filepath.FromSlash(rel))
	if !strings.HasPrefix(p, dir+string(filepath.Separator)) {
		return "", fmt.Errorf("文件路径不合法：%s", rel)
	}
	return p, nil
}

func (s *Session) skillSync(raw json.RawMessage) (any, error) {
	if ok, why := s.Info().Permissions.Allow(perm.CatFS, perm.Write); !ok {
		return nil, errors.New(why)
	}
	var p struct {
		Name  string `json:"name"`
		Hash  string `json:"hash"`
		Files []struct {
			Path string `json:"path"`
			Data string `json:"data"` // base64
		} `json:"files"`
	}
	if err := json.Unmarshal(raw, &p); err != nil || !hashRe.MatchString(p.Hash) || len(p.Files) == 0 {
		return nil, errors.New("需要 name、hash 和 files")
	}
	dir := skillDir(p.Name, p.Hash)
	if _, err := os.Stat(filepath.Join(dir, completeMarker)); err == nil {
		return map[string]any{"dir": dir}, nil
	}
	// 先写到临时目录，全部成功后再改名，避免留下半份
	tmp := dir + ".tmp"
	_ = os.RemoveAll(tmp)
	total := 0
	for _, f := range p.Files {
		data, err := base64.StdEncoding.DecodeString(f.Data)
		if err != nil {
			_ = os.RemoveAll(tmp)
			return nil, fmt.Errorf("%s 不是合法的 base64", f.Path)
		}
		total += len(data)
		if total > maxSkillBytes {
			_ = os.RemoveAll(tmp)
			return nil, errors.New("Skill 文件太大（超过 32 MB）")
		}
		dst, err := safeJoin(tmp, f.Path)
		if err != nil {
			_ = os.RemoveAll(tmp)
			return nil, err
		}
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			_ = os.RemoveAll(tmp)
			return nil, err
		}
		if err := os.WriteFile(dst, data, 0o755); err != nil {
			_ = os.RemoveAll(tmp)
			return nil, err
		}
	}
	if err := os.WriteFile(filepath.Join(tmp, completeMarker), []byte(time.Now().Format(time.RFC3339)), 0o644); err != nil {
		_ = os.RemoveAll(tmp)
		return nil, err
	}
	_ = os.RemoveAll(dir)
	if err := os.Rename(tmp, dir); err != nil {
		_ = os.RemoveAll(tmp)
		return nil, err
	}
	log.Printf("[会话 %d] Skill「%s」已同步到 %s（%d 个文件）", s.id, p.Name, dir, len(p.Files))
	return map[string]any{"dir": dir}, nil
}

// ---- stdio MCP ----

func (s *Server) mcpKey(serial, id string) string { return serial + "/" + id }

// mcpOwner MCP 进程归属：优先用手机的设备 ID（换 USB / WiFi 通道后继续使用同一批进程）
func (s *Session) mcpOwner() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.owner != "" {
		return s.owner
	}
	return s.serial
}

func (s *Session) mcpStart(raw json.RawMessage) (any, error) {
	if ok, why := s.Info().Permissions.Allow(perm.CatShell, perm.Dangerous); !ok {
		return nil, errors.New(why)
	}
	var p struct {
		ID string `json:"id"`
		stdiomcp.Config
	}
	if err := json.Unmarshal(raw, &p); err != nil || p.ID == "" || p.Command == "" {
		return nil, errors.New("需要 id 和 command")
	}
	srv := s.server
	key := srv.mcpKey(s.mcpOwner(), p.ID)
	srv.mu.Lock()
	old := srv.mcp[key]
	srv.mu.Unlock()
	if old != nil && old.Alive() && old.Config().Key() == p.Config.Key() {
		return map[string]any{"name": old.Name, "tools": old.Tools}, nil
	}
	if old != nil {
		old.Close()
	}
	c, err := stdiomcp.Start(s.ctx, p.Config)
	if err != nil {
		return nil, err
	}
	srv.mu.Lock()
	if prev := srv.mcp[key]; prev != nil && prev != c {
		go prev.Close()
	}
	srv.mcp[key] = c
	srv.mu.Unlock()
	log.Printf("[会话 %d] 已启动电脑上的 MCP「%s」（%s，%d 个工具）", s.id, p.ID, p.Command, len(c.Tools))
	return map[string]any{"name": c.Name, "tools": c.Tools}, nil
}

func (s *Session) mcpCall(ctx context.Context, raw json.RawMessage) (any, error) {
	if ok, why := s.Info().Permissions.Allow(perm.CatShell, perm.Dangerous); !ok {
		return nil, errors.New(why)
	}
	var p struct {
		ID        string          `json:"id"`
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
	}
	if err := json.Unmarshal(raw, &p); err != nil || p.ID == "" || p.Name == "" {
		return nil, errors.New("需要 id 和 name")
	}
	srv := s.server
	srv.mu.Lock()
	c := srv.mcp[srv.mcpKey(s.mcpOwner(), p.ID)]
	srv.mu.Unlock()
	if c == nil || !c.Alive() {
		return nil, errors.New("MCP 未启动（not_started）")
	}
	args := p.Arguments
	if len(args) == 0 {
		args = json.RawMessage("{}")
	}
	cctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	res, err := c.Request(cctx, "tools/call", map[string]any{"name": p.Name, "arguments": args})
	if err != nil {
		return nil, err
	}
	return res, nil
}

func (s *Session) mcpStop(raw json.RawMessage) (any, error) {
	var p struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(raw, &p)
	s.server.stopMCP(func(key string) bool { return key == s.server.mcpKey(s.mcpOwner(), p.ID) })
	return map[string]any{}, nil
}

// stopMCP 结束符合条件的 MCP 进程。
func (s *Server) stopMCP(match func(key string) bool) {
	s.mu.Lock()
	var list []*stdiomcp.Client
	for k, c := range s.mcp {
		if match(k) {
			list = append(list, c)
			delete(s.mcp, k)
		}
	}
	s.mu.Unlock()
	for _, c := range list {
		c.Close()
	}
}

// StopAllMCP 退出时结束所有 MCP 进程。
func (s *Server) StopAllMCP() {
	s.stopMCP(func(string) bool { return true })
}
