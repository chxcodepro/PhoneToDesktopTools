package tools

import (
	"archive/zip"
	"context"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"p2d/core/internal/perm"
)

// doc_read：读取 Office Open XML 文档（docx / xlsx / pptx，WPS 默认也保存为这些格式）和 PDF 的文字内容。
// 纯 Go 实现，不依赖 Office / WPS / PDF 阅读器。

const maxDocText = 200 * 1024

func registerDoc(r *Registry) {
	r.Add(&Tool{
		Name: "doc_read",
		Description: "读取 Word（.docx / .doc）、Excel（.xlsx / .xls）、PowerPoint（.pptx / .ppt）、PDF 文件的文字内容，不需要打开 Office / WPS / PDF 阅读器；" +
			"WPS 的 .wps / .et / .dps 也可以。Excel 按工作表输出，每行用制表符分隔单元格，行首是行号。PDF 按页输出，长文档用 pages 分段读取；扫描件（图片）读不出文字。" +
			"Word 6.0 / 95、Excel 5.0 / 95 等更老的格式不支持，可让用户另存为新格式。",
		InputSchema: object(map[string]prop{
			"path":     str("文件路径"),
			"sheet":    str("只读取指定的工作表名称（xlsx / xls）"),
			"max_rows": intg("每个工作表最多读取的行数（xlsx / xls），默认 200"),
			"pages":    str("只读取 PDF 的这些页，如 1-3,5；默认从第 1 页读到内容上限"),
		}, "path"),
		Category: perm.CatFS, Kind: perm.Read, Handler: docRead,
	})
}

func docRead(ctx context.Context, raw json.RawMessage) (*Result, error) {
	var a struct {
		Path    string `json:"path"`
		Sheet   string `json:"sheet"`
		MaxRows int    `json:"max_rows"`
		Pages   string `json:"pages"`
	}
	if err := decode(raw, &a); err != nil {
		return nil, err
	}
	p := resolvePath(a.Path)
	ext := strings.ToLower(filepath.Ext(p))
	// 旧版 Office / WPS 文档按内容识别（扩展名不可靠；加了密码的 docx 也是这种格式）
	if isCFB(p) {
		text, err := readLegacy(p, a.Sheet, a.MaxRows)
		if err != nil {
			return nil, err
		}
		return TextResult(truncateMiddle(p+"\n"+text, maxDocText)), nil
	}
	if err := checkMisnamed(p, ext); err != nil {
		return nil, err
	}
	switch ext {
	case ".pdf":
		text, err := readPDF(p, a.Pages)
		if err != nil {
			return nil, err
		}
		return TextResult(p + "\n" + text), nil
	}
	zr, err := zip.OpenReader(p)
	if err != nil {
		return nil, fmt.Errorf("无法打开 %s（不是有效的 Office 文档？）：%v", p, err)
	}
	defer zr.Close()
	files := map[string]*zip.File{}
	for _, f := range zr.File {
		files[f.Name] = f
	}

	var text string
	switch {
	case files["word/document.xml"] != nil:
		text, err = readDocx(files)
	case files["xl/workbook.xml"] != nil:
		if a.MaxRows <= 0 {
			a.MaxRows = 200
		}
		text, err = readXlsx(files, a.Sheet, a.MaxRows)
	case files["ppt/presentation.xml"] != nil:
		text, err = readPptx(files)
	default:
		return nil, errors.New("无法识别的文档类型，只支持 docx / xlsx / pptx / pdf")
	}
	if err != nil {
		return nil, err
	}
	text = truncateMiddle(text, maxDocText)
	return TextResult(fmt.Sprintf("%s\n%s", p, text)), nil
}

func openXML(files map[string]*zip.File, name string) (*xml.Decoder, io.Closer, error) {
	f := files[name]
	if f == nil {
		return nil, nil, fmt.Errorf("文档缺少 %s", name)
	}
	rc, err := f.Open()
	if err != nil {
		return nil, nil, err
	}
	return xml.NewDecoder(rc), rc, nil
}

// ---------- docx ----------

func readDocx(files map[string]*zip.File) (string, error) {
	dec, closer, err := openXML(files, "word/document.xml")
	if err != nil {
		return "", err
	}
	defer closer.Close()

	var out strings.Builder
	var para strings.Builder
	var cells []string
	inTable := 0
	inText := false
	for {
		tok, err := dec.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", fmt.Errorf("解析 docx 失败：%v", err)
		}
		switch t := tok.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "t":
				inText = true
			case "tab":
				para.WriteString("\t")
			case "br", "cr":
				para.WriteString("\n")
			case "tbl":
				inTable++
			case "tr":
				cells = cells[:0]
			}
		case xml.EndElement:
			switch t.Name.Local {
			case "t":
				inText = false
			case "p":
				if inTable > 0 {
					// 单元格内的段落用空格连接
					if para.Len() > 0 {
						para.WriteString(" ")
					}
					continue
				}
				out.WriteString(strings.TrimRight(para.String(), " "))
				out.WriteString("\n")
				para.Reset()
			case "tc":
				cells = append(cells, strings.TrimSpace(para.String()))
				para.Reset()
			case "tr":
				out.WriteString("| " + strings.Join(cells, " | ") + " |\n")
			case "tbl":
				inTable--
			}
		case xml.CharData:
			if inText {
				para.Write(t)
			}
		}
	}
	return strings.TrimSpace(out.String()), nil
}

// ---------- xlsx ----------

type xlsxSheet struct {
	Name string
	Path string
}

func readSharedStrings(files map[string]*zip.File) ([]string, error) {
	if files["xl/sharedStrings.xml"] == nil {
		return nil, nil
	}
	dec, closer, err := openXML(files, "xl/sharedStrings.xml")
	if err != nil {
		return nil, err
	}
	defer closer.Close()
	var out []string
	var cur strings.Builder
	inSI, inT, inRPh := false, false, false
	for {
		tok, err := dec.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("解析共享字符串失败：%v", err)
		}
		switch t := tok.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "si":
				inSI = true
				cur.Reset()
			case "t":
				inT = true
			case "rPh": // 注音，跳过
				inRPh = true
			}
		case xml.EndElement:
			switch t.Name.Local {
			case "si":
				inSI = false
				out = append(out, cur.String())
			case "t":
				inT = false
			case "rPh":
				inRPh = false
			}
		case xml.CharData:
			if inSI && inT && !inRPh {
				cur.Write(t)
			}
		}
	}
	return out, nil
}

func readSheetList(files map[string]*zip.File) ([]xlsxSheet, error) {
	// workbook.xml：工作表名称和关系 ID
	type wbSheet struct {
		Name string `xml:"name,attr"`
		RID  string `xml:"http://schemas.openxmlformats.org/officeDocument/2006/relationships id,attr"`
	}
	var wb struct {
		Sheets []wbSheet `xml:"sheets>sheet"`
	}
	if err := decodeZipXML(files, "xl/workbook.xml", &wb); err != nil {
		return nil, err
	}
	var rels struct {
		Rels []struct {
			ID     string `xml:"Id,attr"`
			Target string `xml:"Target,attr"`
		} `xml:"Relationship"`
	}
	_ = decodeZipXML(files, "xl/_rels/workbook.xml.rels", &rels)
	target := map[string]string{}
	for _, r := range rels.Rels {
		t := r.Target
		if strings.HasPrefix(t, "/") {
			t = strings.TrimPrefix(t, "/")
		} else {
			t = path.Join("xl", t)
		}
		target[r.ID] = t
	}
	var out []xlsxSheet
	for i, s := range wb.Sheets {
		p := target[s.RID]
		if p == "" {
			p = fmt.Sprintf("xl/worksheets/sheet%d.xml", i+1)
		}
		out = append(out, xlsxSheet{Name: s.Name, Path: p})
	}
	return out, nil
}

func decodeZipXML(files map[string]*zip.File, name string, v any) error {
	f := files[name]
	if f == nil {
		return fmt.Errorf("文档缺少 %s", name)
	}
	rc, err := f.Open()
	if err != nil {
		return err
	}
	defer rc.Close()
	return xml.NewDecoder(rc).Decode(v)
}

var cellRefRe = regexp.MustCompile(`^([A-Z]+)(\d+)$`)

func colIndex(letters string) int {
	n := 0
	for _, c := range letters {
		n = n*26 + int(c-'A'+1)
	}
	return n - 1
}

func readXlsx(files map[string]*zip.File, onlySheet string, maxRows int) (string, error) {
	shared, err := readSharedStrings(files)
	if err != nil {
		return "", err
	}
	sheets, err := readSheetList(files)
	if err != nil {
		return "", err
	}
	var names []string
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
		rows, total, err := readSheetRows(files, s.Path, shared, maxRows)
		if err != nil {
			fmt.Fprintf(&out, "\n== %s ==\n（读取失败：%v）\n", s.Name, err)
			continue
		}
		fmt.Fprintf(&out, "\n== %s（%d 行）==\n", s.Name, total)
		for _, r := range rows {
			out.WriteString(r)
			out.WriteString("\n")
		}
		if total > len(rows) {
			fmt.Fprintf(&out, "…还有 %d 行未显示，可增大 max_rows\n", total-len(rows))
		}
	}
	if onlySheet != "" && !found {
		return "", fmt.Errorf("没有名为「%s」的工作表，现有：%s", onlySheet, strings.Join(names, "、"))
	}
	return out.String(), nil
}

func readSheetRows(files map[string]*zip.File, name string, shared []string, maxRows int) ([]string, int, error) {
	dec, closer, err := openXML(files, name)
	if err != nil {
		return nil, 0, err
	}
	defer closer.Close()

	var rows []string
	total := 0
	var cells map[int]string
	rowNum := 0
	var cellRef, cellType string
	var val strings.Builder
	inV, inIS := false, false
	for {
		tok, err := dec.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, 0, fmt.Errorf("解析工作表失败：%v", err)
		}
		switch t := tok.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "row":
				cells = map[int]string{}
				rowNum++
				for _, at := range t.Attr {
					if at.Name.Local == "r" {
						if n, err := strconv.Atoi(at.Value); err == nil {
							rowNum = n
						}
					}
				}
			case "c":
				cellRef, cellType = "", ""
				val.Reset()
				for _, at := range t.Attr {
					switch at.Name.Local {
					case "r":
						cellRef = at.Value
					case "t":
						cellType = at.Value
					}
				}
			case "v":
				inV = true
			case "is":
				inIS = true
			}
		case xml.EndElement:
			switch t.Name.Local {
			case "v":
				inV = false
			case "is":
				inIS = false
			case "c":
				v := val.String()
				switch cellType {
				case "s":
					if i, err := strconv.Atoi(v); err == nil && i >= 0 && i < len(shared) {
						v = shared[i]
					}
				case "b":
					if v == "1" {
						v = "TRUE"
					} else {
						v = "FALSE"
					}
				}
				col := len(cells)
				if m := cellRefRe.FindStringSubmatch(cellRef); m != nil {
					col = colIndex(m[1])
				}
				if v != "" {
					cells[col] = strings.ReplaceAll(strings.ReplaceAll(v, "\t", " "), "\n", " ")
				}
			case "row":
				if len(cells) == 0 {
					continue
				}
				total++
				if len(rows) >= maxRows {
					continue
				}
				maxCol := 0
				var keys []int
				for k := range cells {
					keys = append(keys, k)
					if k > maxCol {
						maxCol = k
					}
				}
				sort.Ints(keys)
				parts := make([]string, maxCol+1)
				for _, k := range keys {
					parts[k] = cells[k]
				}
				rows = append(rows, fmt.Sprintf("%d\t%s", rowNum, strings.Join(parts, "\t")))
			}
		case xml.CharData:
			if inV || inIS {
				val.Write(t)
			}
		}
	}
	return rows, total, nil
}

// ---------- pptx ----------

var slideRe = regexp.MustCompile(`^ppt/slides/slide(\d+)\.xml$`)

func readPptx(files map[string]*zip.File) (string, error) {
	type slide struct {
		n    int
		name string
	}
	var slides []slide
	for name := range files {
		if m := slideRe.FindStringSubmatch(name); m != nil {
			n, _ := strconv.Atoi(m[1])
			slides = append(slides, slide{n, name})
		}
	}
	sort.Slice(slides, func(i, j int) bool { return slides[i].n < slides[j].n })
	var out strings.Builder
	for _, s := range slides {
		dec, closer, err := openXML(files, s.name)
		if err != nil {
			continue
		}
		var lines []string
		var para strings.Builder
		inT := false
		for {
			tok, err := dec.Token()
			if err != nil {
				break
			}
			switch t := tok.(type) {
			case xml.StartElement:
				if t.Name.Local == "t" {
					inT = true
				}
			case xml.EndElement:
				switch t.Name.Local {
				case "t":
					inT = false
				case "p":
					if l := strings.TrimSpace(para.String()); l != "" {
						lines = append(lines, l)
					}
					para.Reset()
				}
			case xml.CharData:
				if inT {
					para.Write(t)
				}
			}
		}
		closer.Close()
		fmt.Fprintf(&out, "== 第 %d 页 ==\n%s\n\n", s.n, strings.Join(lines, "\n"))
	}
	if out.Len() == 0 {
		return "（演示文稿中没有文字）", nil
	}
	return strings.TrimSpace(out.String()), nil
}
