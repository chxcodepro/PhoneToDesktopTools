package pdftext

import (
	"bytes"
	"errors"
	"math"
	"strings"
	"unicode"
)

// Doc 一个打开的 PDF。
type Doc struct {
	d     *document
	pages []page
	fonts map[ref]*font
}

type page struct {
	dict dict
	res  dict
}

// Open 解析 PDF 文件内容。设置了打开密码时返回 ErrPassword。
func Open(b []byte) (doc *Doc, err error) {
	defer func() {
		if r := recover(); r != nil {
			doc, err = nil, errors.New("PDF 文件格式异常，无法解析")
		}
	}()
	d, err := open(b)
	if err != nil {
		return nil, err
	}
	x := &Doc{d: d, fonts: map[ref]*font{}}
	root := d.rootDict()
	x.walkPages(root["Pages"], nil, map[int]bool{}, 0)
	return x, nil
}

// NumPages 页数
func (x *Doc) NumPages() int { return len(x.pages) }

func (x *Doc) walkPages(v any, inherited dict, seen map[int]bool, depth int) {
	if depth > 64 || len(x.pages) > 100000 {
		return
	}
	if r, ok := v.(ref); ok {
		if seen[r.num] {
			return
		}
		seen[r.num] = true
	}
	nd := x.d.dictOf(v)
	if nd == nil {
		return
	}
	res := inherited
	if r := x.d.dictOf(nd["Resources"]); r != nil {
		res = r
	}
	kids := x.d.arrayOf(nd["Kids"])
	if nd["Type"] == name("Pages") || (kids != nil && nd["Type"] != name("Page")) {
		for _, k := range kids {
			x.walkPages(k, res, seen, depth+1)
		}
		return
	}
	x.pages = append(x.pages, page{dict: nd, res: res})
}

// PageText 第 i 页（从 0 开始）的文字。unreadable 表示这一页有文字但字体编码无法识别。
func (x *Doc) PageText(i int) (text string, unreadable bool) {
	if i < 0 || i >= len(x.pages) {
		return "", false
	}
	defer func() {
		if r := recover(); r != nil {
			text, unreadable = "", false
		}
	}()
	p := x.pages[i]
	var content []byte
	switch c := x.d.resolve(p.dict["Contents"]).(type) {
	case *stream:
		content, _ = x.d.decodeStream(c)
	case array:
		for _, s := range c {
			if st, ok := x.d.resolve(s).(*stream); ok {
				b, _ := x.d.decodeStream(st)
				content = append(content, b...)
				content = append(content, '\n')
			}
		}
	}
	in := &interp{doc: x, out: &strings.Builder{}}
	in.gs.ctm = identity
	in.gs.th = 1
	in.run(content, p.res, 0, map[int]bool{})
	text = tidy(in.out.String())
	unreadable = in.glyphs > 20 && in.bad*2 > in.glyphs
	return text, unreadable
}

type matrix [6]float64

var identity = matrix{1, 0, 0, 1, 0, 0}

// mul 返回 m × n（先 m 后 n）
func (m matrix) mul(n matrix) matrix {
	return matrix{
		m[0]*n[0] + m[1]*n[2], m[0]*n[1] + m[1]*n[3],
		m[2]*n[0] + m[3]*n[2], m[2]*n[1] + m[3]*n[3],
		m[4]*n[0] + m[5]*n[2] + n[4], m[4]*n[1] + m[5]*n[3] + n[5],
	}
}

func (m matrix) apply(x, y float64) (float64, float64) {
	return m[0]*x + m[2]*y + m[4], m[1]*x + m[3]*y + m[5]
}

type gstate struct {
	ctm                    matrix
	font                   *font
	fs, tc, tw, th, tl, ts float64
}

type interp struct {
	doc      *Doc
	out      *strings.Builder
	gs       gstate
	stack    []gstate
	tm       matrix
	tlm      matrix
	have     bool
	endSpace bool
	lastX    float64
	lastY    float64
	ops      int
	glyphs   int
	bad      int
}

func (in *interp) run(content []byte, res dict, depth int, forms map[int]bool) {
	l := &lexer{b: content}
	var args []any
	localFonts := map[string]*font{}
	for {
		l.skipSpace()
		if l.eof() || in.ops > 2_000_000 {
			return
		}
		v := l.object(0)
		if e, ok := v.(endMark); ok {
			if e != 0 {
				l.p++
			}
			continue
		}
		op, isOp := v.(keyword)
		if !isOp {
			if len(args) < 64 {
				args = append(args, v)
			}
			continue
		}
		in.ops++
		f := func(i int) float64 {
			if i < len(args) {
				return numOr(args[i], 0)
			}
			return 0
		}
		switch op {
		case "q":
			if len(in.stack) < 64 {
				in.stack = append(in.stack, in.gs)
			}
		case "Q":
			if n := len(in.stack); n > 0 {
				in.gs = in.stack[n-1]
				in.stack = in.stack[:n-1]
			}
		case "cm":
			if len(args) >= 6 {
				in.gs.ctm = matrix{f(0), f(1), f(2), f(3), f(4), f(5)}.mul(in.gs.ctm)
			}
		case "BT":
			in.tm, in.tlm = identity, identity
		case "Tf":
			if len(args) >= 2 {
				if n, ok := args[0].(name); ok {
					in.gs.font = in.font(res, string(n), localFonts)
				}
				in.gs.fs = f(1)
			}
		case "Td":
			in.moveLine(f(0), f(1))
		case "TD":
			in.gs.tl = -f(1)
			in.moveLine(f(0), f(1))
		case "Tm":
			if len(args) >= 6 {
				in.tm = matrix{f(0), f(1), f(2), f(3), f(4), f(5)}
				in.tlm = in.tm
			}
		case "T*":
			in.moveLine(0, -in.gs.tl)
		case "TL":
			in.gs.tl = f(0)
		case "Tc":
			in.gs.tc = f(0)
		case "Tw":
			in.gs.tw = f(0)
		case "Tz":
			in.gs.th = f(0) / 100
		case "Ts":
			in.gs.ts = f(0)
		case "Tj":
			if len(args) >= 1 {
				in.show(args[0])
			}
		case "'":
			in.moveLine(0, -in.gs.tl)
			if len(args) >= 1 {
				in.show(args[0])
			}
		case "\"":
			if len(args) >= 3 {
				in.gs.tw, in.gs.tc = f(0), f(1)
				in.moveLine(0, -in.gs.tl)
				in.show(args[2])
			}
		case "TJ":
			if len(args) >= 1 {
				if a, ok := args[0].(array); ok {
					for _, e := range a {
						if n, ok := num(e); ok {
							in.advance(-n / 1000 * in.gs.fs * in.gs.th)
						} else {
							in.show(e)
						}
					}
				}
			}
		case "Do":
			if len(args) >= 1 && depth < 8 {
				if n, ok := args[0].(name); ok {
					in.form(res, string(n), depth, forms)
				}
			}
		case "BI":
			skipInlineImage(l)
		}
		args = args[:0]
	}
}

func (in *interp) font(res dict, n string, local map[string]*font) *font {
	d := in.doc.d
	if f, ok := local[n]; ok {
		return f
	}
	fonts := d.dictOf(res["Font"])
	v := fonts[n]
	var f *font
	if r, ok := v.(ref); ok {
		if f = in.doc.fonts[r]; f == nil {
			f = d.loadFont(v)
			in.doc.fonts[r] = f
		}
	} else {
		f = d.loadFont(v)
	}
	local[n] = f
	return f
}

func (in *interp) form(res dict, n string, depth int, forms map[int]bool) {
	d := in.doc.d
	xo := d.dictOf(res["XObject"])
	v := xo[n]
	r, isRef := v.(ref)
	if isRef {
		if forms[r.num] {
			return
		}
		forms[r.num] = true
		defer delete(forms, r.num)
	}
	st, ok := d.resolve(v).(*stream)
	if !ok || st.dict["Subtype"] != name("Form") {
		return
	}
	data, _ := d.decodeStream(st)
	sub := res
	if r := d.dictOf(st.dict["Resources"]); r != nil {
		sub = r
	}
	saved, savedStack, tm, tlm := in.gs, len(in.stack), in.tm, in.tlm
	if m := d.arrayOf(st.dict["Matrix"]); len(m) == 6 {
		var mm matrix
		for i := range mm {
			mm[i] = numOr(d.resolve(m[i]), identity[i])
		}
		in.gs.ctm = mm.mul(in.gs.ctm)
	}
	in.run(data, sub, depth+1, forms)
	in.gs, in.tm, in.tlm = saved, tm, tlm
	if len(in.stack) > savedStack {
		in.stack = in.stack[:savedStack]
	}
}

func (in *interp) moveLine(tx, ty float64) {
	in.tlm = matrix{1, 0, 0, 1, tx, ty}.mul(in.tlm)
	in.tm = in.tlm
}

func (in *interp) advance(tx float64) {
	in.tm = matrix{1, 0, 0, 1, tx, 0}.mul(in.tm)
}

func (in *interp) show(v any) {
	s, ok := v.([]byte)
	if !ok || in.gs.font == nil {
		return
	}
	gs := &in.gs
	for _, g := range gs.font.decode(s) {
		trm := in.tm.mul(gs.ctm)
		x, y := trm.apply(0, gs.ts)
		size := math.Abs(gs.fs) * math.Hypot(trm[2], trm[3])
		if size < 0.1 {
			size = 0.1
		}
		in.emit(g.text, x, y, size)
		w := g.width*gs.fs + gs.tc
		if g.space {
			w += gs.tw
		}
		in.advance(w * gs.th)
		ex, ey := in.tm.mul(gs.ctm).apply(0, gs.ts)
		if g.text != "" {
			in.lastX, in.lastY = ex, ey
		}
	}
}

func (in *interp) emit(text string, x, y, size float64) {
	in.glyphs++
	if !readable(text) {
		in.bad++
		return
	}
	if in.have {
		if math.Abs(y-in.lastY) > size*0.5 {
			in.out.WriteByte('\n')
		} else if gap := x - in.lastX; gap > size*0.22 && !in.endSpace && !strings.HasPrefix(text, " ") {
			in.out.WriteByte(' ')
		}
	}
	in.out.WriteString(text)
	in.endSpace = strings.HasSuffix(text, " ")
	in.have = true
}

func readable(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r == unicode.ReplacementChar || (r >= 0xE000 && r <= 0xF8FF) || (r < 0x20 && r != '\t') {
			return false
		}
	}
	return true
}

// skipInlineImage 跳过「BI ... ID 二进制 EI」
func skipInlineImage(l *lexer) {
	for !l.eof() {
		v := l.object(0)
		if kw, ok := v.(keyword); ok && kw == "ID" {
			break
		}
		if e, ok := v.(endMark); ok && e != 0 {
			l.p++
		}
	}
	l.p++
	for l.p+2 <= len(l.b) {
		k := bytes.Index(l.b[l.p:], []byte("EI"))
		if k < 0 {
			l.p = len(l.b)
			return
		}
		at := l.p + k
		before := at == 0 || isWhite(l.b[at-1])
		after := at+2 == len(l.b) || isWhite(l.b[at+2])
		l.p = at + 2
		if before && after {
			return
		}
	}
}

// tidy 去掉行尾空格，合并连续空行
func tidy(s string) string {
	lines := strings.Split(s, "\n")
	out := make([]string, 0, len(lines))
	blank := 0
	for _, ln := range lines {
		ln = strings.TrimRight(ln, " \t")
		if ln == "" {
			blank++
			if blank > 1 {
				continue
			}
		} else {
			blank = 0
		}
		out = append(out, ln)
	}
	return strings.TrimSpace(strings.Join(out, "\n"))
}
