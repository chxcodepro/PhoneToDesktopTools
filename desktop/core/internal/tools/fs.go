package tools

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"

	"p2d/core/internal/perm"
	"p2d/core/internal/textenc"
)

const (
	maxReadFileSize   = 20 << 20 // fs_read / fs_edit 支持的最大文件
	maxSearchFileSize = 5 << 20  // fs_search 内容搜索时跳过更大的文件
	defaultReadLines  = 500
)

func registerFS(r *Registry) {
	listDesc := "列出目录内容（名称、类型、大小、修改时间）。"
	if runtime.GOOS == "windows" {
		listDesc += "path 传空字符串时列出所有盘符。"
	}
	r.Add(&Tool{
		Name:        "fs_list",
		Description: listDesc + "相对路径以用户主目录为基准，支持 ~ 表示主目录。",
		InputSchema: object(map[string]prop{
			"path":        str("目录路径"),
			"show_hidden": boolean("是否显示隐藏文件，默认否"),
		}, "path"),
		Category: perm.CatFS, Kind: perm.Read, Handler: fsList,
	})
	r.Add(&Tool{
		Name:        "fs_read",
		Description: "读取文本文件，带行号返回。自动识别 UTF-8 / GBK 编码。大文件用 offset 和 limit 分段读取。Office/PDF 等二进制文件不能直接读取。",
		InputSchema: object(map[string]prop{
			"path":   str("文件路径"),
			"offset": intg("起始行号，从 1 开始，默认 1"),
			"limit":  intg("读取行数，默认 500"),
		}, "path"),
		Category: perm.CatFS, Kind: perm.Read, Handler: fsRead,
	})
	r.Add(&Tool{
		Name:        "fs_write",
		Description: "写入文本文件（覆盖已有内容），自动创建上级目录。修改已有文件的一部分时，优先使用 fs_edit。",
		InputSchema: object(map[string]prop{
			"path":     str("文件路径"),
			"content":  str("完整文件内容"),
			"encoding": enum("编码，默认 utf-8。给老旧 Windows 程序用的文件（如 .bat）可选 gbk", "utf-8", "gbk"),
		}, "path", "content"),
		Category: perm.CatFS, Kind: perm.Write, Handler: fsWrite,
	})
	r.Add(&Tool{
		Name:        "fs_edit",
		Description: "查找并替换文件中的一段文字。old_string 必须在文件中唯一出现（否则请加上更多上下文，或设置 replace_all）。保留原文件的编码和换行符。",
		InputSchema: object(map[string]prop{
			"path":        str("文件路径"),
			"old_string":  str("要替换的原文（需与文件内容完全一致）"),
			"new_string":  str("替换后的文字"),
			"replace_all": boolean("是否替换所有匹配，默认否"),
		}, "path", "old_string", "new_string"),
		Category: perm.CatFS, Kind: perm.Write, Handler: fsEdit,
	})
	r.Add(&Tool{
		Name:        "fs_search",
		Description: "在目录下递归搜索文件。name 按文件名通配符匹配（如 *.xlsx、*报表*），content 搜索文本文件中包含的文字。两者可同时使用。",
		InputSchema: object(map[string]prop{
			"path":        str("搜索的起始目录"),
			"name":        str("文件名通配符，不区分大小写"),
			"content":     str("文件内容中要包含的文字"),
			"max_results": intg("最多返回条数，默认 100"),
		}, "path"),
		Category: perm.CatFS, Kind: perm.Read, Handler: fsSearch,
	})
	r.Add(&Tool{
		Name:        "fs_delete",
		Description: "删除文件或目录（移到回收站，可恢复）。",
		InputSchema: object(map[string]prop{
			"path": str("要删除的文件或目录"),
		}, "path"),
		Category: perm.CatFS, Kind: perm.Dangerous, Handler: fsDelete,
	})
}

// resolvePath 展开 ~，相对路径以主目录为基准。
func resolvePath(p string) string {
	p = strings.TrimSpace(p)
	home, _ := os.UserHomeDir()
	if p == "~" {
		return home
	}
	if strings.HasPrefix(p, "~/") || strings.HasPrefix(p, `~\`) {
		p = filepath.Join(home, p[2:])
	}
	if runtime.GOOS == "windows" && len(p) == 2 && p[1] == ':' {
		p += `\` // "D:" 表示当前目录，统一成根目录
	}
	if !filepath.IsAbs(p) {
		p = filepath.Join(home, p)
	}
	return filepath.Clean(p)
}

func fmtSize(n int64) string {
	switch {
	case n >= 1<<30:
		return fmt.Sprintf("%.1f GB", float64(n)/(1<<30))
	case n >= 1<<20:
		return fmt.Sprintf("%.1f MB", float64(n)/(1<<20))
	case n >= 1<<10:
		return fmt.Sprintf("%.1f KB", float64(n)/(1<<10))
	default:
		return fmt.Sprintf("%d B", n)
	}
}

func fsList(ctx context.Context, raw json.RawMessage) (*Result, error) {
	var a struct {
		Path       string `json:"path"`
		ShowHidden bool   `json:"show_hidden"`
	}
	if err := decode(raw, &a); err != nil {
		return nil, err
	}
	if strings.TrimSpace(a.Path) == "" {
		if runtime.GOOS == "windows" {
			return TextResult("盘符：\n" + strings.Join(listDrives(), "\n")), nil
		}
		a.Path = "/"
	}
	dir := resolvePath(a.Path)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, fmt.Errorf("无法读取目录 %s：%v", dir, err)
	}
	sort.SliceStable(entries, func(i, j int) bool {
		if entries[i].IsDir() != entries[j].IsDir() {
			return entries[i].IsDir()
		}
		return strings.ToLower(entries[i].Name()) < strings.ToLower(entries[j].Name())
	})
	const maxEntries = 1000
	var lines []string
	hidden, shown := 0, 0
	for _, e := range entries {
		info, err := e.Info()
		if err != nil {
			continue
		}
		if !a.ShowHidden && isHidden(dir, e.Name(), info) {
			hidden++
			continue
		}
		if shown >= maxEntries {
			continue
		}
		shown++
		mod := info.ModTime().Format("2006-01-02 15:04")
		if e.IsDir() {
			lines = append(lines, fmt.Sprintf("[目录] %s  (%s)", e.Name(), mod))
		} else {
			lines = append(lines, fmt.Sprintf("[文件] %s  %s  (%s)", e.Name(), fmtSize(info.Size()), mod))
		}
	}
	header := fmt.Sprintf("%s（%d 项", dir, shown)
	if hidden > 0 {
		header += fmt.Sprintf("，另有 %d 个隐藏项", hidden)
	}
	if len(entries)-hidden > maxEntries {
		header += fmt.Sprintf("，只显示前 %d 项", maxEntries)
	}
	header += "）"
	return TextResult(header + "\n" + joinLines(lines)), nil
}

func readTextFile(path string) (content string, enc textenc.Encoding, err error) {
	info, err := os.Stat(path)
	if err != nil {
		return "", "", fmt.Errorf("无法访问 %s：%v", path, err)
	}
	if info.IsDir() {
		return "", "", fmt.Errorf("%s 是目录，请用 fs_list", path)
	}
	if info.Size() > maxReadFileSize {
		return "", "", fmt.Errorf("文件过大（%s），超过 %s 上限", fmtSize(info.Size()), fmtSize(maxReadFileSize))
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return "", "", fmt.Errorf("读取失败：%v", err)
	}
	if textenc.IsBinary(b) {
		return "", "", fmt.Errorf("%s 是二进制文件，无法按文本读取", path)
	}
	content, enc = textenc.Decode(b)
	return content, enc, nil
}

func fsRead(ctx context.Context, raw json.RawMessage) (*Result, error) {
	var a struct {
		Path   string `json:"path"`
		Offset int    `json:"offset"`
		Limit  int    `json:"limit"`
	}
	if err := decode(raw, &a); err != nil {
		return nil, err
	}
	path := resolvePath(a.Path)
	content, enc, err := readTextFile(path)
	if err != nil {
		return nil, err
	}
	lines := strings.Split(strings.ReplaceAll(content, "\r\n", "\n"), "\n")
	if n := len(lines); n > 0 && lines[n-1] == "" {
		lines = lines[:n-1]
	}
	if a.Offset < 1 {
		a.Offset = 1
	}
	if a.Limit <= 0 {
		a.Limit = defaultReadLines
	}
	total := len(lines)
	if total == 0 {
		return TextResult(fmt.Sprintf("%s（编码 %s）：空文件", path, enc)), nil
	}
	if a.Offset > total {
		return nil, fmt.Errorf("文件只有 %d 行，offset=%d 超出范围", total, a.Offset)
	}
	end := a.Offset - 1 + a.Limit
	if end > total {
		end = total
	}
	var sb strings.Builder
	fmt.Fprintf(&sb, "%s（编码 %s，共 %d 行，显示第 %d-%d 行）\n", path, enc, total, a.Offset, end)
	for i := a.Offset - 1; i < end; i++ {
		line := lines[i]
		if len(line) > 2000 {
			line = line[:2000] + "…（本行过长已截断）"
		}
		fmt.Fprintf(&sb, "%6d\t%s\n", i+1, line)
	}
	if end < total {
		fmt.Fprintf(&sb, "…还有 %d 行，可用 offset=%d 继续读取\n", total-end, end+1)
	}
	return TextResult(sb.String()), nil
}

func fsWrite(ctx context.Context, raw json.RawMessage) (*Result, error) {
	var a struct {
		Path     string `json:"path"`
		Content  string `json:"content"`
		Encoding string `json:"encoding"`
	}
	if err := decode(raw, &a); err != nil {
		return nil, err
	}
	path := resolvePath(a.Path)
	enc := textenc.UTF8
	if strings.EqualFold(a.Encoding, "gbk") {
		enc = textenc.GBK
	}
	data, err := textenc.Encode(a.Content, enc)
	if err != nil {
		return nil, fmt.Errorf("内容无法用 %s 编码：%v", enc, err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, fmt.Errorf("无法创建目录：%v", err)
	}
	_, statErr := os.Stat(path)
	existed := statErr == nil
	if err := os.WriteFile(path, data, 0o644); err != nil {
		return nil, fmt.Errorf("写入失败：%v", err)
	}
	verb := "已创建"
	if existed {
		verb = "已覆盖"
	}
	return TextResult(fmt.Sprintf("%s %s（%s，编码 %s）", verb, path, fmtSize(int64(len(data))), enc)), nil
}

func fsEdit(ctx context.Context, raw json.RawMessage) (*Result, error) {
	var a struct {
		Path       string `json:"path"`
		OldString  string `json:"old_string"`
		NewString  string `json:"new_string"`
		ReplaceAll bool   `json:"replace_all"`
	}
	if err := decode(raw, &a); err != nil {
		return nil, err
	}
	if a.OldString == "" {
		return nil, errors.New("old_string 不能为空")
	}
	if a.OldString == a.NewString {
		return nil, errors.New("old_string 与 new_string 相同，无需修改")
	}
	path := resolvePath(a.Path)
	content, enc, err := readTextFile(path)
	if err != nil {
		return nil, err
	}
	oldS, newS := a.OldString, a.NewString
	// 文件用 CRLF 而模型给的是 LF 时，自动转换
	if strings.Contains(content, "\r\n") && !strings.Contains(oldS, "\r\n") {
		oldS = strings.ReplaceAll(oldS, "\n", "\r\n")
		newS = strings.ReplaceAll(strings.ReplaceAll(newS, "\r\n", "\n"), "\n", "\r\n")
	}
	count := strings.Count(content, oldS)
	switch {
	case count == 0:
		return nil, errors.New("文件中没有找到 old_string，请先用 fs_read 确认原文（注意空格、缩进）")
	case count > 1 && !a.ReplaceAll:
		return nil, fmt.Errorf("old_string 在文件中出现了 %d 次，请加上更多上下文使其唯一，或设置 replace_all", count)
	}
	n := 1
	if a.ReplaceAll {
		n = -1
	}
	updated := strings.Replace(content, oldS, newS, n)
	data, err := textenc.Encode(updated, enc)
	if err != nil {
		return nil, fmt.Errorf("新内容无法用原编码 %s 保存：%v", enc, err)
	}
	info, _ := os.Stat(path)
	mode := os.FileMode(0o644)
	if info != nil {
		mode = info.Mode().Perm()
	}
	if err := os.WriteFile(path, data, mode); err != nil {
		return nil, fmt.Errorf("写入失败：%v", err)
	}
	replaced := 1
	if a.ReplaceAll {
		replaced = count
	}
	return TextResult(fmt.Sprintf("已修改 %s：替换 %d 处（编码 %s）", path, replaced, enc)), nil
}

func fsSearch(ctx context.Context, raw json.RawMessage) (*Result, error) {
	var a struct {
		Path       string `json:"path"`
		Name       string `json:"name"`
		Content    string `json:"content"`
		MaxResults int    `json:"max_results"`
	}
	if err := decode(raw, &a); err != nil {
		return nil, err
	}
	if a.Name == "" && a.Content == "" {
		return nil, errors.New("name 和 content 至少填一个")
	}
	if a.MaxResults <= 0 {
		a.MaxResults = 100
	}
	root := resolvePath(a.Path)
	pattern := strings.ToLower(a.Name)
	if pattern != "" {
		if _, err := filepath.Match(pattern, ""); err != nil {
			return nil, fmt.Errorf("通配符格式错误：%v", err)
		}
	}
	deadline := time.Now().Add(30 * time.Second)
	var results []string
	scanned := 0
	stopReason := ""
	errStop := errors.New("stop")

	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			if d != nil && d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if ctx.Err() != nil {
			stopReason = "已取消"
			return errStop
		}
		if len(results) >= a.MaxResults {
			stopReason = fmt.Sprintf("已达到 %d 条上限", a.MaxResults)
			return errStop
		}
		if time.Now().After(deadline) {
			stopReason = "搜索超过 30 秒，已停止，请缩小目录范围"
			return errStop
		}
		if d.IsDir() {
			name := d.Name()
			if p != root && (name == "node_modules" || name == ".git" || name == "$RECYCLE.BIN" || name == "System Volume Information") {
				return fs.SkipDir
			}
			return nil
		}
		scanned++
		if pattern != "" {
			if ok, _ := filepath.Match(pattern, strings.ToLower(d.Name())); !ok {
				return nil
			}
		}
		if a.Content == "" {
			info, _ := d.Info()
			size := ""
			if info != nil {
				size = "  " + fmtSize(info.Size())
			}
			results = append(results, p+size)
			return nil
		}
		info, err := d.Info()
		if err != nil || info.Size() > maxSearchFileSize {
			return nil
		}
		b, err := os.ReadFile(p)
		if err != nil || textenc.IsBinary(b) {
			return nil
		}
		text, _ := textenc.Decode(b)
		if !strings.Contains(text, a.Content) {
			return nil
		}
		for i, line := range strings.Split(text, "\n") {
			if strings.Contains(line, a.Content) {
				line = strings.TrimRight(line, "\r")
				if len(line) > 200 {
					line = line[:200] + "…"
				}
				results = append(results, fmt.Sprintf("%s:%d: %s", p, i+1, strings.TrimSpace(line)))
				if len(results) >= a.MaxResults {
					break
				}
			}
		}
		return nil
	})
	if err != nil && !errors.Is(err, errStop) {
		return nil, fmt.Errorf("搜索失败：%v", err)
	}
	header := fmt.Sprintf("在 %s 中找到 %d 条结果（扫描 %d 个文件）", root, len(results), scanned)
	if stopReason != "" {
		header += "，" + stopReason
	}
	if len(results) == 0 {
		return TextResult(header), nil
	}
	return TextResult(header + "\n" + joinLines(results)), nil
}

func fsDelete(ctx context.Context, raw json.RawMessage) (*Result, error) {
	var a struct {
		Path string `json:"path"`
	}
	if err := decode(raw, &a); err != nil {
		return nil, err
	}
	if strings.TrimSpace(a.Path) == "" {
		return nil, errors.New("path 不能为空")
	}
	path := resolvePath(a.Path)
	if path == filepath.VolumeName(path)+string(filepath.Separator) {
		return nil, errors.New("不能删除磁盘根目录")
	}
	if home, _ := os.UserHomeDir(); path == filepath.Clean(home) {
		return nil, errors.New("不能删除用户主目录")
	}
	if _, err := os.Lstat(path); err != nil {
		return nil, fmt.Errorf("无法访问 %s：%v", path, err)
	}
	if err := moveToTrash(path); err != nil {
		return nil, fmt.Errorf("移到回收站失败：%v", err)
	}
	return TextResult("已移到回收站：" + path), nil
}
