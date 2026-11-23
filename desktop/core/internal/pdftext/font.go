package pdftext

import (
	"strconv"
	"strings"
	"unicode/utf16"

	"golang.org/x/text/encoding"
	"golang.org/x/text/encoding/charmap"
	"golang.org/x/text/encoding/japanese"
	"golang.org/x/text/encoding/korean"
	"golang.org/x/text/encoding/simplifiedchinese"
	"golang.org/x/text/encoding/traditionalchinese"
)

// font 把字符串里的字节解码成文字，并给出每个字的宽度（用于判断空格和换行）。
type font struct {
	composite bool
	ranges    []codeRange       // 编码长度（复合字体）
	toUni     map[uint32]string // ToUnicode
	multiEnc  encoding.Encoding // 预定义的中日韩编码（GBK-EUC-H 等）
	ucs2      bool              // UniGB-UCS2-H 之类：编码本身就是 UTF-16
	simple    [256]string       // 简单字体的编码表
	widths    map[uint32]float64
	defWidth  float64
	scale     float64 // 宽度 → 文字空间（一般 1/1000，Type3 按 FontMatrix）
	identity  bool    // Identity-H/V：编码就是 CID
}

type codeRange struct {
	lo, hi uint32
	n      int
}

type glyph struct {
	code  uint32
	text  string
	width float64 // 文字空间单位（已乘 scale）
	space bool    // 单字节 32（字间距 Tw 只作用在它上面）
}

func (d *document) loadFont(v any) *font {
	fd := d.dictOf(v)
	f := &font{widths: map[uint32]float64{}, scale: 0.001, defWidth: 500}
	if fd == nil {
		f.simpleEncoding(nil, nil)
		return f
	}
	sub, _ := d.resolve(fd["Subtype"]).(name)
	if sub == "Type3" {
		if m := d.arrayOf(fd["FontMatrix"]); len(m) > 0 {
			f.scale = numOr(d.resolve(m[0]), 0.001)
		}
	}
	if sub == "Type0" {
		f.composite = true
		f.defWidth = 1000
		switch e := d.resolve(fd["Encoding"]).(type) {
		case name:
			f.predefinedCMap(string(e))
		case *stream:
			data, _ := d.decodeStream(e)
			f.ranges = parseCodespace(data)
			if len(f.ranges) == 0 {
				f.ranges = []codeRange{{0, 0xffff, 2}}
			}
			if cm, ok := e.dict["CMapName"].(name); ok {
				f.predefinedCMap(string(cm))
			}
		default:
			f.predefinedCMap("Identity-H")
		}
		if desc := d.arrayOf(fd["DescendantFonts"]); len(desc) > 0 {
			dd := d.dictOf(desc[0])
			f.defWidth = numOr(d.resolve(dd["DW"]), 1000)
			f.cidWidths(d, d.arrayOf(dd["W"]))
		}
	} else {
		first := intOr(d.resolve(fd["FirstChar"]), 0)
		for i, w := range d.arrayOf(fd["Widths"]) {
			f.widths[uint32(first+i)] = numOr(d.resolve(w), 0)
		}
		if desc := d.dictOf(fd["FontDescriptor"]); desc != nil {
			if mw, ok := num(d.resolve(desc["MissingWidth"])); ok && mw > 0 {
				f.defWidth = mw
			}
		}
		var diffs array
		var base any
		switch e := d.resolve(fd["Encoding"]).(type) {
		case name:
			base = e
		case dict:
			base = d.resolve(e["BaseEncoding"])
			diffs = d.arrayOf(e["Differences"])
		}
		f.simpleEncoding(base, diffs)
	}
	if tu, ok := d.resolve(fd["ToUnicode"]).(*stream); ok {
		data, _ := d.decodeStream(tu)
		f.parseToUnicode(data)
	}
	return f
}

func (f *font) predefinedCMap(n string) {
	switch {
	case n == "Identity-H" || n == "Identity-V":
		f.identity = true
		f.ranges = []codeRange{{0, 0xffff, 2}}
	case strings.Contains(n, "UCS2") || strings.Contains(n, "UTF16"):
		f.ucs2 = true
		f.ranges = []codeRange{{0, 0xffff, 2}}
	default:
		var enc encoding.Encoding
		switch {
		case strings.HasPrefix(n, "GB"):
			enc = simplifiedchinese.GBK
		case strings.HasPrefix(n, "B5") || strings.HasPrefix(n, "ETen") || strings.HasPrefix(n, "HKscs") || strings.HasPrefix(n, "CNS"):
			enc = traditionalchinese.Big5
		case strings.Contains(n, "RKSJ"):
			enc = japanese.ShiftJIS
		case strings.HasPrefix(n, "EUC") || strings.HasPrefix(n, "Ext-") || n == "H" || n == "V":
			enc = japanese.EUCJP
		case strings.HasPrefix(n, "KSC"):
			enc = korean.EUCKR
		}
		if enc != nil {
			f.multiEnc = enc
			// 双字节编码：高位字节 ≥ 0x81 时占两个字节
			if len(f.ranges) == 0 {
				f.ranges = []codeRange{{0, 0x80, 1}, {0x8140, 0xfefe, 2}}
			}
		} else if len(f.ranges) == 0 {
			f.ranges = []codeRange{{0, 0xffff, 2}}
		}
	}
}

func (f *font) cidWidths(d *document, w array) {
	for i := 0; i < len(w); {
		first, ok := num(d.resolve(w[i]))
		if !ok || i+1 >= len(w) {
			return
		}
		if list, ok := d.resolve(w[i+1]).(array); ok {
			for k, x := range list {
				f.widths[uint32(first)+uint32(k)] = numOr(d.resolve(x), f.defWidth)
			}
			i += 2
			continue
		}
		if i+2 >= len(w) {
			return
		}
		last := numOr(d.resolve(w[i+1]), first)
		wd := numOr(d.resolve(w[i+2]), f.defWidth)
		if last-first <= 65535 {
			for c := uint32(first); c <= uint32(last); c++ {
				f.widths[c] = wd
			}
		}
		i += 3
	}
}

func (f *font) simpleEncoding(base any, diffs array) {
	var cm *charmap.Charmap = charmap.Windows1252
	if base == name("MacRomanEncoding") {
		cm = charmap.Macintosh
	}
	dec := cm.NewDecoder()
	for i := 0; i < 256; i++ {
		s, err := dec.Bytes([]byte{byte(i)})
		if err == nil && len(s) > 0 && s[0] >= 0x20 {
			f.simple[i] = string(s)
		}
	}
	if base == name("StandardEncoding") || base == nil {
		f.simple['\''] = "’"
		f.simple['`'] = "‘"
		if base == nil {
			f.simple['\''] = "'"
			f.simple['`'] = "`"
		}
	}
	code := 0
	for _, v := range diffs {
		switch x := v.(type) {
		case int64:
			code = int(x)
		case float64:
			code = int(x)
		case name:
			if code >= 0 && code < 256 {
				if s := glyphText(string(x)); s != "" {
					f.simple[code] = s
				}
			}
			code++
		}
	}
}

// glyphText 字形名 → 文字（常见名称 + uniXXXX / uXXXX）
func glyphText(g string) string {
	if i := strings.IndexByte(g, '.'); i > 0 {
		g = g[:i]
	}
	if s, ok := glyphNames[g]; ok {
		return s
	}
	if strings.HasPrefix(g, "uni") && len(g) >= 7 && (len(g)-3)%4 == 0 {
		var units []uint16
		for i := 3; i+4 <= len(g); i += 4 {
			v, err := strconv.ParseUint(g[i:i+4], 16, 16)
			if err != nil {
				return ""
			}
			units = append(units, uint16(v))
		}
		return string(utf16.Decode(units))
	}
	if strings.HasPrefix(g, "u") && len(g) >= 5 && len(g) <= 7 {
		if v, err := strconv.ParseUint(g[1:], 16, 32); err == nil {
			return string(rune(v))
		}
	}
	if len(g) == 1 {
		return g
	}
	return ""
}

var glyphNames = map[string]string{
	"space": " ", "exclam": "!", "quotedbl": "\"", "numbersign": "#", "dollar": "$", "percent": "%",
	"ampersand": "&", "quotesingle": "'", "quoteright": "’", "quoteleft": "‘", "parenleft": "(", "parenright": ")",
	"asterisk": "*", "plus": "+", "comma": ",", "hyphen": "-", "minus": "−", "period": ".", "slash": "/",
	"zero": "0", "one": "1", "two": "2", "three": "3", "four": "4", "five": "5", "six": "6", "seven": "7",
	"eight": "8", "nine": "9", "colon": ":", "semicolon": ";", "less": "<", "equal": "=", "greater": ">",
	"question": "?", "at": "@", "bracketleft": "[", "backslash": "\\", "bracketright": "]", "asciicircum": "^",
	"underscore": "_", "grave": "`", "braceleft": "{", "bar": "|", "braceright": "}", "asciitilde": "~",
	"bullet": "•", "endash": "–", "emdash": "—", "quotedblleft": "“", "quotedblright": "”", "ellipsis": "…",
	"fi": "fi", "fl": "fl", "ff": "ff", "ffi": "ffi", "ffl": "ffl", "copyright": "©", "registered": "®",
	"trademark": "™", "degree": "°", "multiply": "×", "divide": "÷", "plusminus": "±", "section": "§",
	"paragraph": "¶", "dagger": "†", "daggerdbl": "‡", "periodcentered": "·", "guillemotleft": "«",
	"guillemotright": "»", "nbspace": " ", "sterling": "£", "yen": "¥", "Euro": "€", "cent": "¢",
	"dotlessi": "ı", "germandbls": "ß", "aacute": "á", "eacute": "é", "iacute": "í", "oacute": "ó",
	"uacute": "ú", "agrave": "à", "egrave": "è", "adieresis": "ä", "odieresis": "ö", "udieresis": "ü",
	"Adieresis": "Ä", "Odieresis": "Ö", "Udieresis": "Ü", "ccedilla": "ç", "ntilde": "ñ",
	"quotesinglbase": "‚", "quotedblbase": "„", "exclamdown": "¡", "questiondown": "¿",
}

// parseCodespace 读取 CMap 里的 begincodespacerange
func parseCodespace(data []byte) []codeRange {
	var out []codeRange
	l := &lexer{b: data}
	in := false
	var pend [][]byte
	for !l.eof() {
		v := l.object(0)
		if _, end := v.(endMark); end {
			l.p++
			continue
		}
		switch x := v.(type) {
		case keyword:
			switch x {
			case "begincodespacerange":
				in, pend = true, nil
			case "endcodespacerange":
				in = false
			}
		case []byte:
			if in {
				pend = append(pend, x)
				if len(pend) == 2 {
					if n := len(pend[0]); n >= 1 && n <= 4 {
						out = append(out, codeRange{beUint(pend[0]), beUint(pend[1]), n})
					}
					pend = nil
				}
			}
		}
	}
	return out
}

func beUint(b []byte) uint32 {
	var v uint32
	for _, c := range b {
		v = v<<8 | uint32(c)
	}
	return v
}

func utf16be(b []byte) string {
	if len(b) == 1 {
		return string(rune(b[0]))
	}
	units := make([]uint16, 0, len(b)/2)
	for i := 0; i+1 < len(b); i += 2 {
		units = append(units, uint16(b[i])<<8|uint16(b[i+1]))
	}
	return string(utf16.Decode(units))
}

func (f *font) parseToUnicode(data []byte) {
	l := &lexer{b: data}
	f.toUni = map[uint32]string{}
	mode := ""
	var args []any
	var space []codeRange
	for !l.eof() {
		v := l.object(0)
		if _, end := v.(endMark); end {
			l.p++
			continue
		}
		if kw, ok := v.(keyword); ok {
			switch kw {
			case "begincodespacerange", "beginbfchar", "beginbfrange":
				mode, args = string(kw), nil
			case "endcodespacerange", "endbfchar", "endbfrange":
				mode = ""
			}
			continue
		}
		if mode == "" {
			continue
		}
		args = append(args, v)
		switch mode {
		case "begincodespacerange":
			if len(args) == 2 {
				lo, _ := args[0].([]byte)
				hi, _ := args[1].([]byte)
				if n := len(lo); n >= 1 && n <= 4 {
					space = append(space, codeRange{beUint(lo), beUint(hi), n})
				}
				args = nil
			}
		case "beginbfchar":
			if len(args) == 2 {
				src, _ := args[0].([]byte)
				switch dst := args[1].(type) {
				case []byte:
					f.toUni[beUint(src)] = utf16be(dst)
				case name:
					f.toUni[beUint(src)] = glyphText(string(dst))
				}
				args = nil
			}
		case "beginbfrange":
			if len(args) == 3 {
				lo, _ := args[0].([]byte)
				hi, _ := args[1].([]byte)
				a, b := beUint(lo), beUint(hi)
				if b >= a && b-a <= 65535 {
					switch dst := args[2].(type) {
					case []byte:
						if len(dst) >= 1 {
							units := make([]uint16, 0, len(dst)/2+1)
							for i := 0; i+1 < len(dst); i += 2 {
								units = append(units, uint16(dst[i])<<8|uint16(dst[i+1]))
							}
							if len(dst) == 1 {
								units = append(units, uint16(dst[0]))
							}
							for c := a; c <= b; c++ {
								u := append([]uint16{}, units...)
								u[len(u)-1] += uint16(c - a)
								f.toUni[c] = string(utf16.Decode(u))
							}
						}
					case array:
						for i, x := range dst {
							if s, ok := x.([]byte); ok && a+uint32(i) <= b {
								f.toUni[a+uint32(i)] = utf16be(s)
							}
						}
					}
				}
				args = nil
			}
		}
	}
	// 复合字体的编码长度以字体编码为准；只有拿不到时才用 ToUnicode 的
	if len(f.ranges) == 0 && f.composite && len(space) > 0 {
		f.ranges = space
	}
}

// decode 把字符串拆成字
func (f *font) decode(s []byte) []glyph {
	var out []glyph
	for i := 0; i < len(s); {
		n := 1
		if f.composite {
			n = f.codeLen(s[i:])
		}
		if i+n > len(s) {
			n = len(s) - i
		}
		raw := s[i : i+n]
		code := beUint(raw)
		i += n
		g := glyph{code: code, space: n == 1 && code == 32}
		if t, ok := f.toUni[code]; ok {
			g.text = t
		} else if f.composite {
			switch {
			case f.ucs2:
				g.text = utf16be(raw)
			case f.multiEnc != nil:
				if b, err := f.multiEnc.NewDecoder().Bytes(raw); err == nil {
					g.text = string(b)
				}
			}
		} else {
			g.text = f.simple[code&0xff]
		}
		w, ok := f.widths[code]
		if !ok {
			w = f.defWidth
		}
		g.width = w * f.scale
		out = append(out, g)
	}
	return out
}

func (f *font) codeLen(s []byte) int {
	if len(f.ranges) == 0 {
		return 2
	}
	for n := 1; n <= 4 && n <= len(s); n++ {
		v := beUint(s[:n])
		for _, r := range f.ranges {
			if r.n == n && v >= r.lo && v <= r.hi {
				return n
			}
		}
	}
	// 不在任何范围里：按最短的范围长度前进
	shortest := 4
	for _, r := range f.ranges {
		if r.n < shortest {
			shortest = r.n
		}
	}
	return shortest
}
