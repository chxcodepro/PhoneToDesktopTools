package olddoc

import (
	"encoding/binary"
	"errors"
	"strings"
	"unicode/utf16"

	"golang.org/x/text/encoding/charmap"
)

// ErrEncrypted 文件设置了打开密码
var ErrEncrypted = errors.New("这个文件设置了打开密码，无法读取")

// maxWordRunes 最多读出的字数。分段表里的多个分段可以指向同一块数据，不设上限会被放大成几 GB。
const maxWordRunes = 4 << 20

var errOldWord = errors.New("这是 Word 6.0 / 95 的老格式，暂不支持，请让用户用 Word / WPS 另存为 .docx")

// Word 97-2003（[MS-DOC]）：正文在 WordDocument 流里，由 1Table / 0Table 流里的分段表（piece table）拼出来。

// wordParts 文档各部分（正文、脚注、页眉页脚……）的文字
type wordParts struct {
	Body, Footnotes, Headers, Comments, Endnotes, Textboxes string
}

func readWord(f *cfbFile) (*wordParts, error) {
	wd, ok := f.stream("WordDocument")
	if !ok || len(wd) < 0x1AA {
		return nil, errors.New("不是 Word 文档（缺少 WordDocument）")
	}
	le := binary.LittleEndian
	switch le.Uint16(wd[0:]) {
	case 0xA5EC:
	case 0xA5DC:
		return nil, errOldWord
	default:
		return nil, errors.New("Word 文档头不正确，文件可能已损坏")
	}
	nFib := le.Uint16(wd[2:])
	flags := le.Uint16(wd[0x0A:])
	if flags&0x0100 != 0 { // fEncrypted
		return nil, ErrEncrypted
	}
	if nFib < 0x00C0 { // 0x65 / 0x68 是 Word 6 / 95，表结构不同
		return nil, errOldWord
	}
	table := "0Table"
	if flags&0x0200 != 0 { // fWhichTblStm
		table = "1Table"
	}
	tbl, ok := f.stream(table)
	if !ok {
		return nil, errors.New("Word 文档缺少 " + table + " 流，文件可能已损坏")
	}
	fcClx := le.Uint32(wd[0x1A2:])
	lcbClx := le.Uint32(wd[0x1A6:])
	if uint64(fcClx)+uint64(lcbClx) > uint64(len(tbl)) || lcbClx == 0 {
		return nil, errors.New("Word 文档的分段表不完整，文件可能已损坏")
	}
	clx := tbl[fcClx : fcClx+lcbClx]
	// 跳过 Prc（格式修订），找到 Pcdt
	p := 0
	for p < len(clx) && clx[p] == 0x01 {
		if p+3 > len(clx) {
			break
		}
		p += 3 + int(le.Uint16(clx[p+1:]))
	}
	if p+5 > len(clx) || clx[p] != 0x02 {
		return nil, errors.New("Word 文档的分段表格式不对")
	}
	lcb := int(le.Uint32(clx[p+1:]))
	plc := clx[p+5:]
	if lcb < len(plc) {
		plc = plc[:lcb]
	}
	// PlcPcd：(n+1) 个 CP + n 个 8 字节的 Pcd
	n := (len(plc) - 4) / 12
	if n <= 0 {
		return &wordParts{}, nil
	}
	var text []rune
	cp1252 := charmap.Windows1252
	for i := 0; i < n && len(text) < maxWordRunes; i++ {
		cpStart := le.Uint32(plc[i*4:])
		cpEnd := le.Uint32(plc[(i+1)*4:])
		if cpEnd <= cpStart || cpEnd-cpStart > 1<<26 {
			continue
		}
		cnt := int(cpEnd - cpStart)
		pcd := plc[(n+1)*4+i*8:]
		fc := le.Uint32(pcd[2:])
		if fc&0x40000000 != 0 { // 压缩：每字一个字节（cp1252）
			off := int(fc&^0x40000000) / 2
			for k := 0; k < cnt && off+k < len(wd) && len(text) < maxWordRunes; k++ {
				c := wd[off+k]
				if c < 0x80 {
					text = append(text, rune(c))
				} else {
					text = append(text, cp1252.DecodeByte(c))
				}
			}
		} else {
			off := int(fc)
			if off >= len(wd) {
				continue
			}
			// 按实际有的数据和剩余额度分配，不按分段表里声明的长度
			if avail := (len(wd) - off) / 2; cnt > avail {
				cnt = avail
			}
			if room := maxWordRunes - len(text); cnt > room {
				cnt = room
			}
			units := make([]uint16, 0, cnt)
			for k := 0; k < cnt && off+2*k+1 < len(wd); k++ {
				units = append(units, le.Uint16(wd[off+2*k:]))
			}
			text = append(text, utf16.Decode(units)...)
		}
	}
	// 各部分的长度（FibRgLw97）
	ccp := func(off int) int { return int(int32(le.Uint32(wd[off:]))) }
	lens := []int{ccp(0x4C), ccp(0x50), ccp(0x54), ccp(0x58), ccp(0x5C), ccp(0x60), ccp(0x64), ccp(0x68)}
	var parts [8]string
	pos := 0
	for i, l := range lens {
		if l <= 0 {
			continue
		}
		end := pos + l
		if end > len(text) {
			end = len(text)
		}
		if pos < end {
			parts[i] = cleanWordText(text[pos:end])
		}
		pos = end
	}
	if lens[0] <= 0 { // 长度信息缺失：全部当正文
		parts[0] = cleanWordText(text)
	}
	return &wordParts{Body: parts[0], Footnotes: parts[1], Headers: parts[2], Comments: parts[4], Endnotes: parts[5], Textboxes: parts[6]}, nil
}

// cleanWordText 处理 Word 的特殊字符：段落、表格单元格、域代码等
func cleanWordText(rs []rune) string {
	var out strings.Builder
	var cur strings.Builder
	var cells []string
	fields := []bool{} // 每层域：true 表示在域代码部分（不输出）
	inCode := func() bool {
		for _, c := range fields {
			if c {
				return true
			}
		}
		return false
	}
	var prev rune
	flushLine := func() {
		out.WriteString(strings.TrimRight(cur.String(), " \t"))
		out.WriteByte('\n')
		cur.Reset()
	}
	for _, r := range rs {
		raw := r
		switch r {
		case 0x13: // 域开始：先是域代码
			fields = append(fields, true)
		case 0x14: // 域分隔：之后是显示结果
			if len(fields) > 0 {
				fields[len(fields)-1] = false
			}
		case 0x15: // 域结束
			if len(fields) > 0 {
				fields = fields[:len(fields)-1]
			}
		case 0x07: // 单元格结束；紧跟在单元格结束后面的是行结束
			if prev == 0x07 {
				if len(cells) > 0 {
					out.WriteString("| " + strings.Join(cells, " | ") + " |\n")
				}
				cells = nil
			} else {
				cells = append(cells, strings.TrimSpace(cur.String()))
				cur.Reset()
			}
		case '\r':
			if inCode() {
				break
			}
			if len(cells) > 0 { // 单元格里的段落用空格连接
				cur.WriteByte(' ')
			} else {
				flushLine()
			}
		case 0x0B, 0x0C, 0x0E: // 手动换行、分页 / 分节、分栏
			if !inCode() {
				if len(cells) > 0 {
					cur.WriteByte(' ')
				} else {
					flushLine()
				}
			}
		case '\t':
			if !inCode() {
				cur.WriteByte('\t')
			}
		case 0x1E:
			if !inCode() {
				cur.WriteByte('-')
			}
		case 0xA0:
			if !inCode() {
				cur.WriteByte(' ')
			}
		default:
			if r < 0x20 || r == 0x1F || r == 0xFFFD || inCode() {
				break // 图片、脚注引用等占位符
			}
			cur.WriteRune(r)
		}
		prev = raw
	}
	if len(cells) > 0 {
		out.WriteString("| " + strings.Join(cells, " | ") + " |\n")
	}
	if cur.Len() > 0 {
		flushLine()
	}
	return tidyLines(out.String())
}

// tidyLines 去掉行尾空白，合并连续空行
func tidyLines(s string) string {
	lines := strings.Split(s, "\n")
	out := make([]string, 0, len(lines))
	blank := 0
	for _, ln := range lines {
		ln = strings.TrimRight(ln, " \t　")
		if strings.TrimSpace(ln) == "" {
			blank++
			if blank > 1 {
				continue
			}
			ln = ""
		} else {
			blank = 0
		}
		out = append(out, ln)
	}
	return strings.TrimSpace(strings.Join(out, "\n"))
}
