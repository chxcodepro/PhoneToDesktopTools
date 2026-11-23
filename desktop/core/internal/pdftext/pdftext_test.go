package pdftext

import (
	"bytes"
	"compress/zlib"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/text/encoding/simplifiedchinese"
)

// buildPDF 按顺序写出对象（编号从 1 开始），生成带交叉引用表的 PDF。
// 对象内容里用 {STREAM:...} 不方便，所以直接传完整的对象体。
func buildPDF(objs []string, trailerExtra string) []byte {
	var b bytes.Buffer
	b.WriteString("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
	offs := make([]int, len(objs)+1)
	for i, o := range objs {
		offs[i+1] = b.Len()
		fmt.Fprintf(&b, "%d 0 obj\n%s\nendobj\n", i+1, o)
	}
	x := b.Len()
	fmt.Fprintf(&b, "xref\n0 %d\n0000000000 65535 f \n", len(objs)+1)
	for i := 1; i <= len(objs); i++ {
		fmt.Fprintf(&b, "%010d 00000 n \n", offs[i])
	}
	fmt.Fprintf(&b, "trailer\n<< /Size %d /Root 1 0 R %s >>\nstartxref\n%d\n%%%%EOF\n", len(objs)+1, trailerExtra, x)
	return b.Bytes()
}

func streamObj(dictExtra string, data []byte) string {
	return fmt.Sprintf("<< /Length %d %s >>\nstream\n%s\nendstream", len(data), dictExtra, data)
}

func deflate(data []byte) []byte {
	var b bytes.Buffer
	w := zlib.NewWriter(&b)
	w.Write(data)
	w.Close()
	return b.Bytes()
}

func pageText(t *testing.T, pdf []byte, i int) string {
	t.Helper()
	doc, err := Open(pdf)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if i >= doc.NumPages() {
		t.Fatalf("只有 %d 页", doc.NumPages())
	}
	s, _ := doc.PageText(i)
	return s
}

// 简单字体：WinAnsi + Differences、TJ 字距、换行、' 操作符
func TestSimpleFont(t *testing.T) {
	content := []byte(`BT /F1 12 Tf 72 700 Td (Hello) Tj ( World) Tj 0 -14 Td [(Ke) 20 (rn) -400 (gap)] TJ
14 TL (third line) ' T* (\101\102\103 \(x\)) Tj ET`)
	pdf := buildPDF([]string{
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
		streamObj("", content),
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding << /BaseEncoding /WinAnsiEncoding /Differences [65 /uni4E2D /bullet] >> >>",
	}, "")
	got := pageText(t, pdf, 0)
	want := "Hello World\nKern gap\nthird line\n中•C (x)"
	if got != want {
		t.Fatalf("得到：%q\n应为：%q", got, want)
	}
}

// 复合字体：Identity-H + ToUnicode（bfchar / bfrange）+ Flate 压缩 + /W 宽度
func TestType0ToUnicode(t *testing.T) {
	cmap := []byte(`/CIDInit /ProcSet findresource begin 12 dict begin begincmap
1 begincodespacerange <0000> <FFFF> endcodespacerange
2 beginbfchar <0001> <4F60> <0002> <597D> endbfchar
1 beginbfrange <0010> <0012> <4E16> endbfrange
1 beginbfrange <0020> <0021> [<0041> <D83DDE00>] endbfrange
endcmap CMapName currentdict /CMap defineresource pop end end`)
	content := deflate([]byte(`BT /F1 10 Tf 1 0 0 1 50 500 Tm <00010002> Tj <0010> Tj 0 -20 Td <00200021> Tj ET`))
	pdf := buildPDF([]string{
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
		streamObj("/Filter /FlateDecode", content),
		"<< /Type /Font /Subtype /Type0 /BaseFont /SimSun /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 7 0 R >>",
		"<< /Type /Font /Subtype /CIDFontType2 /BaseFont /SimSun /DW 1000 /W [1 [1000 1000] 16 18 1000] >>",
		streamObj("", cmap),
	}, "")
	if got, want := pageText(t, pdf, 0), "你好世\nA😀"; got != want {
		t.Fatalf("得到：%q 应为：%q", got, want)
	}
}

// 预定义的中文编码：GBK-EUC-H（内容是 GBK 字节）和 UniGB-UCS2-H
func TestPredefinedCMaps(t *testing.T) {
	gbk, _ := simplifiedchinese.GBK.NewEncoder().Bytes([]byte("中文A"))
	content := []byte(fmt.Sprintf("BT /G 12 Tf 10 700 Td <%X> Tj 0 -20 Td /U 12 Tf <4E2D658700410042> Tj ET", gbk))
	pdf := buildPDF([]string{
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /G 5 0 R /U 6 0 R >> >> >>",
		streamObj("", content),
		"<< /Type /Font /Subtype /Type0 /BaseFont /STSong /Encoding /GBK-EUC-H /DescendantFonts [<< /Subtype /CIDFontType0 /DW 1000 >>] >>",
		"<< /Type /Font /Subtype /Type0 /BaseFont /STSong /Encoding /UniGB-UCS2-H /DescendantFonts [<< /Subtype /CIDFontType0 /DW 1000 >>] >>",
	}, "")
	if got, want := pageText(t, pdf, 0), "中文A\n中文AB"; got != want {
		t.Fatalf("得到：%q 应为：%q", got, want)
	}
}

// 表单对象里的文字、内嵌图片（数据里含 EI 字样）、q/Q
func TestFormXObjectAndInlineImage(t *testing.T) {
	content := []byte("q BI /W 4 /H 1 /BPC 8 /CS /G ID \x00EIx\x01 EI Q BT /F1 12 Tf 10 700 Td (before) Tj ET q 1 0 0 1 0 -40 cm /X1 Do Q")
	form := []byte("BT /F1 12 Tf 10 700 Td (inside form) Tj ET")
	pdf := buildPDF([]string{
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 /Resources << /Font << /F1 5 0 R >> /XObject << /X1 6 0 R >> >> >>",
		"<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>", // Resources 从父节点继承
		streamObj("", content),
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
		streamObj("/Type /XObject /Subtype /Form /BBox [0 0 600 800]", form),
	}, "")
	if got, want := pageText(t, pdf, 0), "before\ninside form"; got != want {
		t.Fatalf("得到：%q 应为：%q", got, want)
	}
}

// 交叉引用流（PNG 预测器）+ 对象流，没有传统的 trailer
func TestXrefStreamAndObjStm(t *testing.T) {
	var b bytes.Buffer
	b.WriteString("%PDF-1.5\n")
	content := []byte("BT /F1 12 Tf 10 700 Td (from object stream) Tj ET")
	// 对象 1~3、5 放进对象流 6，内容流 4 直接写在文件里
	inner := []string{
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	}
	nums := []int{1, 2, 3, 5}
	var head, body bytes.Buffer
	for i, o := range inner {
		fmt.Fprintf(&head, "%d %d ", nums[i], body.Len())
		body.WriteString(o + "\n")
	}
	objstm := append(head.Bytes(), body.Bytes()...)
	off4 := b.Len()
	fmt.Fprintf(&b, "4 0 obj\n%s\nendobj\n", streamObj("", content))
	off6 := b.Len()
	fmt.Fprintf(&b, "6 0 obj\n%s\nendobj\n", streamObj(fmt.Sprintf("/Type /ObjStm /N 4 /First %d /Filter /FlateDecode", head.Len()), deflate(objstm)))
	off7 := b.Len()
	// 交叉引用流：W [1 2 1]，每行前加 PNG Up 过滤字节
	rows := [][]byte{
		{0, 0, 0, 0},
		{2, 0, 6, 0}, {2, 0, 6, 1}, {2, 0, 6, 2},
		{1, byte(off4 >> 8), byte(off4), 0},
		{2, 0, 6, 3},
		{1, byte(off6 >> 8), byte(off6), 0},
		{1, byte(off7 >> 8), byte(off7), 0},
	}
	var raw []byte
	prev := make([]byte, 4)
	for _, r := range rows {
		raw = append(raw, 2)
		for i := range r {
			raw = append(raw, r[i]-prev[i])
		}
		prev = r
	}
	fmt.Fprintf(&b, "7 0 obj\n%s\nendobj\n", streamObj("/Type /XRef /Size 8 /W [1 2 1] /Root 1 0 R /Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns 4 >>", deflate(raw)))
	fmt.Fprintf(&b, "startxref\n%d\n%%%%EOF\n", off7)
	if got := pageText(t, b.Bytes(), 0); got != "from object stream" {
		t.Fatalf("得到：%q", got)
	}
}

// 交叉引用表偏移错误：扫描文件重建
func TestBrokenXref(t *testing.T) {
	pdf := buildPDF([]string{
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
		streamObj("", []byte("BT /F1 12 Tf (recovered) Tj ET")),
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	}, "")
	pdf = bytes.Replace(pdf, []byte("startxref\n"), []byte("startxref\n9"), 1) // 偏移变成一个错误的数
	if got := pageText(t, pdf, 0); got != "recovered" {
		t.Fatalf("得到：%q", got)
	}
}

func TestNotPDF(t *testing.T) {
	if _, err := Open([]byte("hello world")); err == nil {
		t.Fatal("应报错")
	}
	if _, err := Open([]byte("%PDF-1.4\n garbage without objects")); err == nil {
		t.Fatal("应报错")
	}
}

// testdata 里的加密文件由 pypdf 生成（打开密码为空，权限密码 owner-secret；need-password 的打开密码是 1234）
func TestEncrypted(t *testing.T) {
	files, _ := filepath.Glob("testdata/enc-*.pdf")
	if len(files) < 4 {
		t.Fatalf("缺少测试文件：%v", files)
	}
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		doc, err := Open(b)
		if strings.Contains(f, "need-password") {
			if err != ErrPassword {
				t.Errorf("%s：应报需要密码，实际 %v", f, err)
			}
			continue
		}
		if err != nil {
			t.Errorf("%s：%v", f, err)
			continue
		}
		s, _ := doc.PageText(0)
		if s != "加密测试 Encrypted 123" {
			t.Errorf("%s：得到 %q", f, s)
		}
	}
}
