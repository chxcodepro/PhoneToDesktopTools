package tools

import (
	"errors"
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"

	"p2d/core/internal/pdftext"
)

const maxPDFFile = 200 << 20

// readPDF 读取 PDF 的文字。pages 形如 "1-3,5"（从 1 开始），为空时从第 1 页读到内容上限。
func readPDF(p, pages string) (string, error) {
	st, err := os.Stat(p)
	if err != nil {
		return "", fmt.Errorf("无法打开 %s：%v", p, err)
	}
	if st.Size() > maxPDFFile {
		return "", fmt.Errorf("文件太大（%d MB），最多读取 %d MB 的 PDF", st.Size()>>20, maxPDFFile>>20)
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return "", fmt.Errorf("无法读取 %s：%v", p, err)
	}
	doc, err := pdftext.Open(b)
	if errors.Is(err, pdftext.ErrPassword) {
		return "", errors.New("这个 PDF 设置了打开密码，无法读取。可以让用户在电脑上用密码打开它，再用 screen_capture 查看")
	}
	if err != nil {
		return "", fmt.Errorf("无法读取 %s：%v", p, err)
	}
	n := doc.NumPages()
	if n == 0 {
		return "", errors.New("这个 PDF 没有页面")
	}
	list, err := parsePages(pages, n)
	if err != nil {
		return "", err
	}

	var sb strings.Builder
	fmt.Fprintf(&sb, "共 %d 页", n)
	if pages != "" {
		fmt.Fprintf(&sb, "，读取第 %s 页", pages)
	}
	sb.WriteString("\n")
	total, unreadable := 0, 0
	for k, i := range list {
		text, bad := doc.PageText(i - 1)
		switch {
		case bad:
			unreadable++
			if text == "" {
				text = "（这一页的文字用了无法识别的字体编码）"
			} else {
				text += "\n（这一页有部分文字用了无法识别的字体编码）"
			}
		case text == "":
			text = "（这一页没有文字，可能是图片）"
		default:
			total += utf8.RuneCountInString(text)
		}
		if k > 0 && sb.Len()+len(text) > maxDocText {
			fmt.Fprintf(&sb, "\n……内容太长，只读到第 %d 页。用 pages 参数继续读后面的页，如 pages=\"%d-%d\"", list[k-1], i, list[len(list)-1])
			break
		}
		fmt.Fprintf(&sb, "\n—— 第 %d 页 ——\n%s\n", i, text)
	}
	if total == 0 && unreadable == 0 {
		return "", fmt.Errorf("这个 PDF（共 %d 页）没有可提取的文字，可能是扫描件或全是图片。可以让用户在电脑上打开它，再用 screen_capture 识别屏幕上的文字", n)
	}
	return truncateMiddle(sb.String(), maxDocText+512), nil
}

// parsePages 解析 "1-3,5"，返回去重排序后的页码
func parsePages(spec string, n int) ([]int, error) {
	if strings.TrimSpace(spec) == "" {
		all := make([]int, n)
		for i := range all {
			all[i] = i + 1
		}
		return all, nil
	}
	seen := map[int]bool{}
	bad := fmt.Errorf("pages 格式不对：%q，应为 1-3,5 这样的页码（共 %d 页）", spec, n)
	for _, part := range strings.FieldsFunc(spec, func(r rune) bool { return r == ',' || r == '，' || r == ' ' }) {
		lo, hi := part, part
		if i := strings.IndexAny(part, "-~～"); i >= 0 {
			lo, hi = part[:i], strings.TrimLeft(part[i:], "-~～")
		}
		a, err1 := strconv.Atoi(lo)
		b, err2 := strconv.Atoi(hi)
		if err1 != nil || err2 != nil || a < 1 || b < a {
			return nil, bad
		}
		if a > n {
			continue
		}
		if b > n {
			b = n
		}
		for i := a; i <= b; i++ {
			seen[i] = true
		}
	}
	if len(seen) == 0 {
		return nil, fmt.Errorf("没有要读的页：这个 PDF 只有 %d 页", n)
	}
	out := make([]int, 0, len(seen))
	for i := range seen {
		out = append(out, i)
	}
	sort.Ints(out)
	return out, nil
}
