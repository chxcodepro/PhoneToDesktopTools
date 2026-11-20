package tools

import (
	"archive/zip"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeZip(t *testing.T, p string, files map[string]string) {
	t.Helper()
	f, err := os.Create(p)
	if err != nil {
		t.Fatal(err)
	}
	zw := zip.NewWriter(f)
	for name, body := range files {
		w, _ := zw.Create(name)
		_, _ = w.Write([]byte(body))
	}
	_ = zw.Close()
	_ = f.Close()
}

const wNS = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"`

func TestDocReadDocx(t *testing.T) {
	p := filepath.Join(t.TempDir(), "报告.docx")
	writeZip(t, p, map[string]string{
		"word/document.xml": `<w:document ` + wNS + `><w:body>
<w:p><w:r><w:t>第一段</w:t></w:r><w:r><w:t xml:space="preserve"> 文字</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>名称</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>数量</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>苹果</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>3</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
<w:p><w:r><w:t>结尾</w:t></w:r></w:p></w:body></w:document>`,
	})
	txt, isErr := call(t, NewRegistry(), "doc_read", map[string]any{"path": p})
	if isErr {
		t.Fatal(txt)
	}
	for _, want := range []string{"第一段 文字", "| 名称 | 数量 |", "| 苹果 | 3 |", "结尾"} {
		if !strings.Contains(txt, want) {
			t.Fatalf("缺少 %q：\n%s", want, txt)
		}
	}
}

func TestDocReadXlsx(t *testing.T) {
	p := filepath.Join(t.TempDir(), "11月-销售.xlsx")
	writeZip(t, p, map[string]string{
		"xl/workbook.xml": `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>
<sheet name="销售" sheetId="1" r:id="rId1"/><sheet name="汇总" sheetId="2" r:id="rId2"/></sheets></workbook>`,
		"xl/_rels/workbook.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>`,
		"xl/sharedStrings.xml": `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>产品</t></si><si><t>金额</t></si><si><r><t>键</t></r><r><t>盘</t></r></si></sst>`,
		"xl/worksheets/sheet1.xml": `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
<row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2"><v>199.5</v></c></row>
<row r="3"><c r="A3" t="inlineStr"><is><t>鼠标</t></is></c><c r="B3" t="b"><v>1</v></c></row></sheetData></worksheet>`,
		"xl/worksheets/sheet2.xml": `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>`,
	})
	r := NewRegistry()
	txt, isErr := call(t, r, "doc_read", map[string]any{"path": p})
	if isErr {
		t.Fatal(txt)
	}
	for _, want := range []string{"工作表：销售、汇总", "== 销售（3 行）==", "1\t产品\t金额", "2\t键盘\t\t199.5", "3\t鼠标\tTRUE"} {
		if !strings.Contains(txt, want) {
			t.Fatalf("缺少 %q：\n%s", want, txt)
		}
	}
	txt, _ = call(t, r, "doc_read", map[string]any{"path": p, "sheet": "销售", "max_rows": 1})
	if !strings.Contains(txt, "还有 2 行") || strings.Contains(txt, "== 汇总") {
		t.Fatalf("分页或筛选不对：\n%s", txt)
	}
	if txt, isErr := call(t, r, "doc_read", map[string]any{"path": p, "sheet": "不存在"}); !isErr {
		t.Fatalf("不存在的工作表应报错：%s", txt)
	}
}

func TestDocReadPptxAndOldFormat(t *testing.T) {
	p := filepath.Join(t.TempDir(), "汇报.pptx")
	aNS := `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"`
	writeZip(t, p, map[string]string{
		"ppt/presentation.xml":  `<p:presentation xmlns:p="x"/>`,
		"ppt/slides/slide2.xml": `<p:sld xmlns:p="x" ` + aNS + `><a:p><a:r><a:t>第二页</a:t></a:r></a:p></p:sld>`,
		"ppt/slides/slide1.xml": `<p:sld xmlns:p="x" ` + aNS + `><a:p><a:r><a:t>标题</a:t></a:r></a:p><a:p><a:r><a:t>要点</a:t></a:r></a:p></p:sld>`,
	})
	r := NewRegistry()
	txt, isErr := call(t, r, "doc_read", map[string]any{"path": p})
	if isErr || strings.Index(txt, "第 1 页") > strings.Index(txt, "第 2 页") || !strings.Contains(txt, "标题\n要点") {
		t.Fatalf("pptx 读取不对：\n%s", txt)
	}
	old := filepath.Join(t.TempDir(), "旧.doc")
	_ = os.WriteFile(old, []byte("x"), 0o644)
	if txt, isErr := call(t, r, "doc_read", map[string]any{"path": old}); !isErr || !strings.Contains(txt, "另存为") {
		t.Fatalf("旧格式应提示另存：%s", txt)
	}
}
