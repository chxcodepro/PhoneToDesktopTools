package tools

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// writePDF 生成每页一段文字的 PDF（Helvetica），texts 为空字符串的页没有文字
func writePDF(t *testing.T, texts []string) string {
	t.Helper()
	var b bytes.Buffer
	b.WriteString("%PDF-1.4\n")
	var offs []int
	obj := func(body string) {
		offs = append(offs, b.Len())
		fmt.Fprintf(&b, "%d 0 obj\n%s\nendobj\n", len(offs), body)
	}
	n := len(texts)
	kids := make([]string, n)
	for i := range texts {
		kids[i] = fmt.Sprintf("%d 0 R", 4+i*2)
	}
	obj("<< /Type /Catalog /Pages 2 0 R >>")
	obj(fmt.Sprintf("<< /Type /Pages /Kids [%s] /Count %d /Resources << /Font << /F1 3 0 R >> >> >>", strings.Join(kids, " "), n))
	obj("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
	for i, s := range texts {
		obj(fmt.Sprintf("<< /Type /Page /Parent 2 0 R /Contents %d 0 R >>", 5+i*2))
		c := "q Q"
		if s != "" {
			c = fmt.Sprintf("BT /F1 12 Tf 72 700 Td (%s) Tj ET", s)
		}
		obj(fmt.Sprintf("<< /Length %d >>\nstream\n%s\nendstream", len(c), c))
	}
	x := b.Len()
	fmt.Fprintf(&b, "xref\n0 %d\n0000000000 65535 f \n", len(offs)+1)
	for _, o := range offs {
		fmt.Fprintf(&b, "%010d 00000 n \n", o)
	}
	fmt.Fprintf(&b, "trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n", len(offs)+1, x)
	p := filepath.Join(t.TempDir(), "测试.pdf")
	if err := os.WriteFile(p, b.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestDocReadPDF(t *testing.T) {
	p := writePDF(t, []string{"page one", "", "page three"})
	r := NewRegistry()
	txt, isErr := call(t, r, "doc_read", map[string]any{"path": p})
	if isErr {
		t.Fatal(txt)
	}
	for _, want := range []string{"共 3 页", "—— 第 1 页 ——\npage one", "—— 第 2 页 ——\n（这一页没有文字，可能是图片）", "—— 第 3 页 ——\npage three"} {
		if !strings.Contains(txt, want) {
			t.Fatalf("缺少 %q：\n%s", want, txt)
		}
	}
	txt, isErr = call(t, r, "doc_read", map[string]any{"path": p, "pages": "3"})
	if isErr || !strings.Contains(txt, "page three") || strings.Contains(txt, "page one") {
		t.Fatalf("pages=3：%s", txt)
	}
	if txt, isErr = call(t, r, "doc_read", map[string]any{"path": p, "pages": "abc"}); !isErr {
		t.Fatalf("pages 格式错误应报错：%s", txt)
	}
}

func TestDocReadPDFNoText(t *testing.T) {
	p := writePDF(t, []string{"", ""})
	txt, isErr := call(t, NewRegistry(), "doc_read", map[string]any{"path": p})
	if !isErr || !strings.Contains(txt, "扫描件") {
		t.Fatalf("没有文字时应提示可能是扫描件：%s", txt)
	}
}

func TestDocReadPDFLong(t *testing.T) {
	line := strings.Repeat("x", 2000)
	pages := make([]string, 150) // 约 300 KB，超过上限
	for i := range pages {
		pages[i] = line
	}
	p := writePDF(t, pages)
	txt, isErr := call(t, NewRegistry(), "doc_read", map[string]any{"path": p})
	if isErr {
		t.Fatal(txt[:200])
	}
	if len(txt) > maxDocText+1024 || !strings.Contains(txt, "用 pages 参数继续读后面的页") {
		t.Fatalf("超长时应截断并提示，长度 %d，结尾：%s", len(txt), txt[len(txt)-200:])
	}
}

func TestDocReadPDFPassword(t *testing.T) {
	p, _ := filepath.Abs("../pdftext/testdata/enc-need-password.pdf")
	txt, isErr := call(t, NewRegistry(), "doc_read", map[string]any{"path": p})
	if !isErr || !strings.Contains(txt, "打开密码") {
		t.Fatalf("应提示需要密码：%s", txt)
	}
	p, _ = filepath.Abs("../pdftext/testdata/enc-aes-256.pdf")
	if txt, isErr = call(t, NewRegistry(), "doc_read", map[string]any{"path": p}); isErr || !strings.Contains(txt, "加密测试 Encrypted 123") {
		t.Fatalf("只有权限密码的文件应能读：%s", txt)
	}
}

func TestParsePages(t *testing.T) {
	for _, c := range []struct {
		spec string
		want []int
	}{
		{"", []int{1, 2, 3, 4, 5}},
		{"2", []int{2}},
		{"1-2,4", []int{1, 2, 4}},
		{"4-99", []int{4, 5}},
		{"3，1～2", []int{1, 2, 3}},
	} {
		got, err := parsePages(c.spec, 5)
		if err != nil || !reflect.DeepEqual(got, c.want) {
			t.Errorf("%q → %v %v，应为 %v", c.spec, got, err, c.want)
		}
	}
	for _, bad := range []string{"0", "3-1", "x", "9"} {
		if _, err := parsePages(bad, 5); err == nil {
			t.Errorf("%q 应报错", bad)
		}
	}
}
