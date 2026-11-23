package olddoc

import (
	"encoding/binary"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"

	"golang.org/x/text/encoding/charmap"
)

// Excel 97-2003（BIFF8，[MS-XLS]）：Workbook 流由一条条记录组成。

// Sheet 一个工作表
type Sheet struct {
	Name string
	Rows []Row // 按行号排序，只含有内容的行
}

// Row 一行，Cells 的键是从 0 开始的列号
type Row struct {
	Num   int // 从 1 开始
	Cells map[int]string
}

const (
	recBOF        = 0x0809
	recEOF        = 0x000A
	recBoundSheet = 0x0085
	recSST        = 0x00FC
	recContinue   = 0x003C
	recLabelSST   = 0x00FD
	recLabel      = 0x0204
	recNumber     = 0x0203
	recRK         = 0x027E
	recMulRK      = 0x00BD
	recFormula    = 0x0006
	recString     = 0x0207
	recBoolErr    = 0x0205
	recFilePass   = 0x002F
	recFormat     = 0x041E
	recXF         = 0x00E0
	recDateMode   = 0x0022
	recRString    = 0x00D6
	recArray      = 0x0221
	recShrFmla    = 0x04BC
	recTable      = 0x0236
)

type xlsRecord struct {
	typ  uint16
	data []byte
	off  int
}

func xlsRecords(b []byte, from int) []xlsRecord {
	var out []xlsRecord
	le := binary.LittleEndian
	for p := from; p+4 <= len(b); {
		typ := le.Uint16(b[p:])
		n := int(le.Uint16(b[p+2:]))
		if p+4+n > len(b) {
			n = len(b) - p - 4
		}
		out = append(out, xlsRecord{typ, b[p+4 : p+4+n], p})
		p += 4 + n
		if typ == recEOF && from > 0 {
			break // 工作表子流结束
		}
	}
	return out
}

// 上限：多个工作表可以指向同一份数据，不设上限会被反复解析放大
const (
	maxSheets = 512
	maxCells  = 2_000_000
)

var cellReplacer = strings.NewReplacer("\t", " ", "\r\n", " ", "\n", " ", "\r", " ")

type xlsBook struct {
	cellCount int
	sst       []string
	xfFmt     []uint16
	formats   map[uint16]string
	date1904  bool
}

func readXls(f *cfbFile) ([]Sheet, error) {
	wb, ok := f.stream("Workbook")
	if !ok {
		if _, old := f.stream("Book"); old {
			return nil, errors.New("这是 Excel 5.0 / 95 的老格式，暂不支持，请让用户用 Excel / WPS 另存为 .xlsx")
		}
		return nil, errors.New("不是 Excel 文档（缺少 Workbook）")
	}
	le := binary.LittleEndian
	if len(wb) < 8 || le.Uint16(wb) != recBOF {
		return nil, errors.New("Excel 文档头不正确，文件可能已损坏")
	}
	if v := le.Uint16(wb[4:]); v != 0x0600 {
		return nil, errors.New("这是 Excel 5.0 / 95 的老格式，暂不支持，请让用户用 Excel / WPS 另存为 .xlsx")
	}
	bk := &xlsBook{formats: map[uint16]string{}}
	type sheetRef struct {
		name string
		pos  int
		kind byte
	}
	var refs []sheetRef
	globals := xlsRecords(wb, 0)
	for i := 0; i < len(globals); i++ {
		r := globals[i]
		d := r.data
		switch r.typ {
		case recFilePass:
			return nil, ErrEncrypted
		case recDateMode:
			bk.date1904 = len(d) >= 2 && le.Uint16(d) == 1
		case recFormat:
			if len(d) >= 4 {
				s, _ := xlUnicodeString(d[2:], true)
				bk.formats[le.Uint16(d)] = s
			}
		case recXF:
			if len(d) >= 4 {
				bk.xfFmt = append(bk.xfFmt, le.Uint16(d[2:]))
			}
		case recBoundSheet:
			if len(d) >= 8 {
				name, _ := shortXLString(d[6:])
				refs = append(refs, sheetRef{name, int(le.Uint32(d)), d[5]})
			}
		case recSST:
			segs := [][]byte{d}
			for i+1 < len(globals) && globals[i+1].typ == recContinue {
				i++
				segs = append(segs, globals[i].data)
			}
			bk.sst = parseSST(segs)
		case recEOF:
			i = len(globals) // 全局部分结束
		}
	}
	var sheets []Sheet
	for _, ref := range refs {
		if len(sheets) >= maxSheets || bk.cellCount >= maxCells {
			break
		}
		if ref.kind != 0 || ref.pos <= 0 || ref.pos >= len(wb) {
			continue // 图表、宏表
		}
		sheets = append(sheets, Sheet{Name: ref.name, Rows: bk.readSheet(wb, ref.pos)})
	}
	return sheets, nil
}

func (bk *xlsBook) readSheet(wb []byte, pos int) []Row {
	le := binary.LittleEndian
	cells := map[int]map[int]string{}
	set := func(row, col int, v string) {
		if v == "" || row < 0 || col < 0 || bk.cellCount >= maxCells {
			return
		}
		if cells[row] == nil {
			cells[row] = map[int]string{}
		}
		if _, exists := cells[row][col]; !exists {
			bk.cellCount++
		}
		cells[row][col] = cellReplacer.Replace(v)
	}
	recs := xlsRecords(wb, pos)
	pendRow, pendCol := -1, -1 // 公式结果是字符串时，值在后面的 STRING 记录里
	for _, r := range recs {
		d := r.data
		switch r.typ {
		case recString, recContinue, recArray, recShrFmla, recTable:
			// 数组公式、共享公式、模拟运算表的记录夹在公式和它的字符串结果之间
		default:
			pendRow = -1
		}
		if len(d) < 6 && r.typ != recString {
			continue
		}
		var row, col, xf int
		if len(d) >= 6 {
			row, col, xf = int(le.Uint16(d)), int(le.Uint16(d[2:])), int(le.Uint16(d[4:]))
		}
		switch r.typ {
		case recLabelSST:
			if len(d) >= 10 {
				if i := int(le.Uint32(d[6:])); i < len(bk.sst) {
					set(row, col, bk.sst[i])
				}
			}
		case recLabel, recRString:
			s, _ := xlUnicodeString(d[6:], true)
			set(row, col, s)
		case recNumber:
			if len(d) >= 14 {
				set(row, col, bk.number(math.Float64frombits(le.Uint64(d[6:])), xf))
			}
		case recRK:
			if len(d) >= 10 {
				set(row, col, bk.number(rk(le.Uint32(d[6:])), xf))
			}
		case recMulRK:
			for k := 0; 4+k*6+6 <= len(d)-2; k++ {
				p := 4 + k*6
				set(row, col+k, bk.number(rk(le.Uint32(d[p+2:])), int(le.Uint16(d[p:]))))
			}
		case recFormula:
			if len(d) < 14 {
				continue
			}
			res := d[6:14]
			if res[6] == 0xFF && res[7] == 0xFF {
				switch res[0] {
				case 0:
					pendRow, pendCol = row, col
				case 1:
					if res[2] != 0 {
						set(row, col, "TRUE")
					} else {
						set(row, col, "FALSE")
					}
				case 2:
					set(row, col, xlError(res[2]))
				}
			} else {
				set(row, col, bk.number(math.Float64frombits(le.Uint64(res)), xf))
			}
		case recString:
			if pendRow >= 0 {
				s, _ := xlUnicodeString(d, true)
				set(pendRow, pendCol, s)
				pendRow = -1
			}
		case recBoolErr:
			if len(d) >= 8 {
				if d[7] == 1 {
					set(row, col, xlError(d[6]))
				} else if d[6] != 0 {
					set(row, col, "TRUE")
				} else {
					set(row, col, "FALSE")
				}
			}
		}
	}
	rows := make([]Row, 0, len(cells))
	for r, c := range cells {
		rows = append(rows, Row{Num: r + 1, Cells: c})
	}
	sortRows(rows)
	return rows
}

func sortRows(rows []Row) {
	for i := 1; i < len(rows); i++ {
		for j := i; j > 0 && rows[j].Num < rows[j-1].Num; j-- {
			rows[j], rows[j-1] = rows[j-1], rows[j]
		}
	}
}

func rk(v uint32) float64 {
	var f float64
	if v&0x02 != 0 {
		f = float64(int32(v) >> 2)
	} else {
		f = math.Float64frombits(uint64(v&0xFFFFFFFC) << 32)
	}
	if v&0x01 != 0 {
		f /= 100
	}
	return f
}

func xlError(c byte) string {
	switch c {
	case 0x00:
		return "#NULL!"
	case 0x07:
		return "#DIV/0!"
	case 0x0F:
		return "#VALUE!"
	case 0x17:
		return "#REF!"
	case 0x1D:
		return "#NAME?"
	case 0x24:
		return "#NUM!"
	case 0x2A:
		return "#N/A"
	}
	return "#ERROR"
}

// number 按单元格格式输出：日期格式转成日期，其余去掉浮点误差
func (bk *xlsBook) number(v float64, xf int) string {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return ""
	}
	if xf >= 0 && xf < len(bk.xfFmt) {
		if kind := dateKind(bk.xfFmt[xf], bk.formats); kind != "" && v >= 0 && v < 2958466 {
			return formatDate(v, bk.date1904, kind)
		}
	}
	if v == math.Trunc(v) && math.Abs(v) < 1e15 {
		return strconv.FormatInt(int64(v), 10)
	}
	f, _ := strconv.ParseFloat(strconv.FormatFloat(v, 'g', 15, 64), 64)
	return strconv.FormatFloat(f, 'f', -1, 64)
}

// dateKind 数字格式是不是日期 / 时间："date"、"time"、"datetime"，不是返回空
func dateKind(id uint16, custom map[uint16]string) string {
	switch {
	case id >= 14 && id <= 17, id == 27, id == 28, id == 29, id == 30, id == 31, id == 34, id == 35, id == 36,
		id >= 50 && id <= 58:
		return "date"
	case id >= 18 && id <= 21, id == 32, id == 33, id == 45, id == 46, id == 47:
		return "time"
	case id == 22:
		return "datetime"
	}
	f, ok := custom[id]
	if !ok {
		return ""
	}
	// 去掉引号里的文字、转义字符、[颜色] 等
	var clean strings.Builder
	inQ := false
	for i := 0; i < len(f); i++ {
		c := f[i]
		switch {
		case c == '"':
			inQ = !inQ
		case inQ:
		case c == '\\' || c == '_' || c == '*':
			i++
		case c == '[':
			if j := strings.IndexByte(f[i:], ']'); j > 0 {
				inner := strings.ToLower(f[i+1 : i+j])
				if inner == "h" || inner == "hh" || inner == "m" || inner == "mm" || inner == "s" || inner == "ss" {
					clean.WriteString("h") // [h]:mm 这类累计时间
				}
				i += j
			}
		default:
			clean.WriteByte(c)
		}
	}
	s := strings.ToLower(clean.String())
	hasDate := strings.ContainsAny(s, "yd") || (strings.Contains(s, "m") && !strings.ContainsAny(s, "hs"))
	hasTime := strings.ContainsAny(s, "hs")
	switch {
	case hasDate && hasTime:
		return "datetime"
	case hasDate:
		return "date"
	case hasTime:
		return "time"
	}
	return ""
}

func formatDate(v float64, date1904 bool, kind string) string {
	base := time.Date(1899, 12, 30, 0, 0, 0, 0, time.UTC)
	if date1904 {
		base = time.Date(1904, 1, 1, 0, 0, 0, 0, time.UTC)
	}
	t := base.Add(time.Duration(math.Round(v*86400)) * time.Second)
	switch {
	case kind == "time" || (v < 1 && kind != "date"):
		return t.Format("15:04:05")
	case kind == "date" || t.Hour()+t.Minute()+t.Second() == 0:
		return t.Format("2006-01-02")
	}
	return t.Format("2006-01-02 15:04:05")
}

// xlUnicodeString：cch（2 字节，wide=true）或 1 字节 + grbit + 字符
func xlUnicodeString(d []byte, wide bool) (string, int) {
	le := binary.LittleEndian
	p := 0
	var cch int
	if wide {
		if len(d) < 3 {
			return "", len(d)
		}
		cch = int(le.Uint16(d))
		p = 2
	} else {
		if len(d) < 2 {
			return "", len(d)
		}
		cch = int(d[0])
		p = 1
	}
	grbit := d[p]
	p++
	runs, ext := 0, 0
	if grbit&0x08 != 0 && p+2 <= len(d) {
		runs = int(le.Uint16(d[p:]))
		p += 2
	}
	if grbit&0x04 != 0 && p+4 <= len(d) {
		ext = int(le.Uint32(d[p:]))
		p += 4
	}
	var s string
	if grbit&0x01 != 0 {
		units := make([]uint16, 0, cch)
		for k := 0; k < cch && p+1 < len(d); k++ {
			units = append(units, le.Uint16(d[p:]))
			p += 2
		}
		s = string(utf16.Decode(units))
	} else {
		var sb strings.Builder
		for k := 0; k < cch && p < len(d); k++ {
			sb.WriteRune(charmap.ISO8859_1.DecodeByte(d[p]))
			p++
		}
		s = sb.String()
	}
	return s, p + runs*4 + ext
}

func shortXLString(d []byte) (string, int) { return xlUnicodeString(d, false) }

// parseSST 共享字符串表。字符串可能跨 CONTINUE 记录：跨界时新的一段开头有 1 字节说明字符宽度。
func parseSST(segs [][]byte) []string {
	le := binary.LittleEndian
	if len(segs) == 0 || len(segs[0]) < 8 {
		return nil
	}
	total := int(le.Uint32(segs[0][4:]))
	if total > 5_000_000 {
		total = 5_000_000
	}
	seg, p := 0, 8
	// next 保证当前段至少还有 n 字节（不够就换到下一段，返回是否换过段）
	avail := func() int { return len(segs[seg]) - p }
	advSeg := func() bool {
		if seg+1 >= len(segs) {
			return false
		}
		seg++
		p = 0
		return true
	}
	readU16 := func() (int, bool) {
		if avail() < 2 && !(avail() == 0 && advSeg() && avail() >= 2) {
			return 0, false
		}
		v := int(le.Uint16(segs[seg][p:]))
		p += 2
		return v, true
	}
	skip := func(n int) {
		for n > 0 {
			if avail() == 0 && !advSeg() {
				return
			}
			k := avail()
			if k > n {
				k = n
			}
			p += k
			n -= k
		}
	}
	// 按实际数据量分配：每个字符串至少占 3 字节
	size := 0
	for _, s := range segs {
		size += len(s)
	}
	if total > size/3 {
		total = size / 3
	}
	out := make([]string, 0, total)
	for len(out) < total {
		cch, ok := readU16()
		if !ok {
			break
		}
		if avail() == 0 && !advSeg() {
			break
		}
		grbit := segs[seg][p]
		p++
		runs, ext := 0, 0
		if grbit&0x08 != 0 {
			v, _ := readU16()
			runs = v
		}
		if grbit&0x04 != 0 {
			if avail() < 4 {
				advSeg()
			}
			if avail() >= 4 {
				ext = int(le.Uint32(segs[seg][p:]))
				p += 4
			}
		}
		wide := grbit&0x01 != 0
		units := make([]uint16, 0, cch)
		for len(units) < cch {
			if avail() == 0 {
				if !advSeg() || avail() == 0 {
					break
				}
				wide = segs[seg][p]&0x01 != 0 // 续接段的字符宽度
				p++
				continue
			}
			if wide {
				if avail() < 2 {
					p = len(segs[seg])
					continue
				}
				units = append(units, le.Uint16(segs[seg][p:]))
				p += 2
			} else {
				units = append(units, uint16(segs[seg][p]))
				p++
			}
		}
		out = append(out, string(utf16.Decode(units)))
		skip(runs*4 + ext)
	}
	return out
}

func (s Sheet) String() string { return fmt.Sprintf("%s(%d rows)", s.Name, len(s.Rows)) }
