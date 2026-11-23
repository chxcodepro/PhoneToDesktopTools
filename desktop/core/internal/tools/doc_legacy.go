package tools

import (
	"errors"
	"fmt"
	"io"
	"os"
	"sort"
	"strings"

	"p2d/core/internal/olddoc"
)

const maxLegacyFile = 200 << 20

// isCFB 文件是不是复合文档（旧版 Office / WPS，或加了密码的 docx / xlsx / pptx）
func isCFB(p string) bool {
	f, err := os.Open(p)
	if err != nil {
		return false
	}
	defer f.Close()
	head := make([]byte, 512)
	n, _ := io.ReadFull(f, head)
	return olddoc.IsCFB(head[:n])
}

var legacyExts = map[string]string{
	".doc": "Word", ".dot": "Word", ".wps": "WPS 文字", ".wpt": "WPS 文字",
	".xls": "Excel", ".xlt": "Excel", ".et": "WPS 表格", ".ett": "WPS 表格",
	".ppt": "PowerPoint", ".pps": "PowerPoint", ".pot": "PowerPoint", ".dps": "WPS 演示", ".dpt": "WPS 演示",
}

// checkMisnamed 旧格式扩展名但内容不是复合文档：常见的是网页 / RTF 另存成 .doc；内容是 zip（新格式）时继续按新格式读
func checkMisnamed(p, ext string) error {
	kind, legacy := legacyExts[ext]
	if !legacy {
		return nil
	}
	f, err := os.Open(p)
	if err != nil {
		return fmt.Errorf("无法打开 %s：%v", p, err)
	}
	defer f.Close()
	head := make([]byte, 1024)
	n, _ := io.ReadFull(f, head)
	head = head[:n]
	trimmed := strings.ToLower(strings.TrimLeft(string(head), "\ufeff \r\n\t"))
	switch {
	case strings.HasPrefix(trimmed, "pk"):
		return nil
	case strings.HasPrefix(trimmed, `{\rtf`):
		return errors.New("这个文件扩展名是 " + ext + "，实际是 RTF 富文本，可以用 fs_read 直接读取它的文字（会带少量格式代码）")
	case strings.HasPrefix(trimmed, "<") && (strings.Contains(trimmed, "<html") || strings.Contains(trimmed, "<!doctype") || strings.Contains(trimmed, "<?xml")):
		return errors.New("这个文件扩展名是 " + ext + "，实际是网页 / XML 文件，可以用 fs_read 直接读取")
	}
	return fmt.Errorf("这不是有效的 %s 文件（%s），文件可能已损坏或扩展名不对", kind, ext)
}

// readLegacy 读取 .doc / .xls / .ppt / .wps / .et / .dps
func readLegacy(p, onlySheet string, maxRows int) (string, error) {
	st, err := os.Stat(p)
	if err != nil {
		return "", fmt.Errorf("无法打开 %s：%v", p, err)
	}
	if st.Size() > maxLegacyFile {
		return "", fmt.Errorf("文件太大（%d MB），最多读取 %d MB", st.Size()>>20, maxLegacyFile>>20)
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return "", fmt.Errorf("无法读取 %s：%v", p, err)
	}
	doc, err := olddoc.Read(b)
	if errors.Is(err, olddoc.ErrEncrypted) {
		return "", errors.New("这个文件设置了打开密码，无法读取。可以让用户在电脑上用密码打开它，再用 screen_capture 查看")
	}
	if err != nil {
		return "", err
	}
	switch doc.Kind {
	case "word":
		w := doc.Word
		var sb strings.Builder
		sb.WriteString(w.Body)
		for _, part := range []struct{ title, text string }{
			{"脚注", w.Footnotes}, {"尾注", w.Endnotes}, {"批注", w.Comments}, {"页眉页脚", w.Headers}, {"文本框", w.Textboxes},
		} {
			if part.text != "" {
				fmt.Fprintf(&sb, "\n\n== %s ==\n%s", part.title, part.text)
			}
		}
		if strings.TrimSpace(sb.String()) == "" {
			return "（文档中没有文字）", nil
		}
		return strings.TrimSpace(sb.String()), nil
	case "excel":
		return formatSheets(doc.Sheets, onlySheet, maxRows)
	default:
		var sb strings.Builder
		for i, s := range doc.Slides {
			fmt.Fprintf(&sb, "== 第 %d 页 ==\n%s\n\n", i+1, strings.Join(s, "\n"))
		}
		if strings.TrimSpace(sb.String()) == "" {
			return "（演示文稿中没有文字）", nil
		}
		return strings.TrimSpace(sb.String()), nil
	}
}

// formatSheets 输出格式和 xlsx 一致
func formatSheets(sheets []olddoc.Sheet, onlySheet string, maxRows int) (string, error) {
	if maxRows <= 0 {
		maxRows = 200
	}
	names := make([]string, 0, len(sheets))
	for _, s := range sheets {
		names = append(names, s.Name)
	}
	var out strings.Builder
	fmt.Fprintf(&out, "工作表：%s\n", strings.Join(names, "、"))
	found := false
	for _, s := range sheets {
		if onlySheet != "" && s.Name != onlySheet {
			continue
		}
		found = true
		fmt.Fprintf(&out, "\n== %s（%d 行）==\n", s.Name, len(s.Rows))
		for i, r := range s.Rows {
			if i >= maxRows {
				fmt.Fprintf(&out, "…还有 %d 行未显示，可增大 max_rows\n", len(s.Rows)-maxRows)
				break
			}
			keys := make([]int, 0, len(r.Cells))
			maxCol := 0
			for k := range r.Cells {
				keys = append(keys, k)
				if k > maxCol {
					maxCol = k
				}
			}
			sort.Ints(keys)
			parts := make([]string, maxCol+1)
			for _, k := range keys {
				parts[k] = r.Cells[k]
			}
			fmt.Fprintf(&out, "%d\t%s\n", r.Num, strings.Join(parts, "\t"))
		}
	}
	if onlySheet != "" && !found {
		return "", fmt.Errorf("没有名为「%s」的工作表，现有：%s", onlySheet, strings.Join(names, "、"))
	}
	return out.String(), nil
}
