package pdftext

import (
	"bytes"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strconv"
)

// xentry 交叉引用表里的一项：typ 1 = 文件偏移，typ 2 = 在对象流里
type xentry struct {
	typ        int
	off        int // typ 1：偏移；typ 2：对象流编号
	gen, index int
}

type document struct {
	b       []byte
	xref    map[int]xentry
	trailer dict
	cache   map[int]any
	loading map[int]bool
	objStms map[int]*objStream
	crypt   *decrypter
}

type objStream struct {
	data []byte
	offs map[int]int // 对象编号 → 在 data 里的偏移
}

// ErrPassword 文件设置了打开密码
var ErrPassword = errors.New("这个 PDF 设置了打开密码，无法读取")

func open(b []byte) (*document, error) {
	if !bytes.HasPrefix(bytes.TrimLeft(b[:min(len(b), 1024)], " \r\n\t\x00"), []byte("%PDF")) && bytes.Index(b[:min(len(b), 1024)], []byte("%PDF")) < 0 {
		return nil, errors.New("不是 PDF 文件")
	}
	d := &document{b: b, xref: map[int]xentry{}, cache: map[int]any{}, loading: map[int]bool{}, objStms: map[int]*objStream{}}
	if err := d.loadXrefChain(); err != nil || d.rootDict() == nil {
		// 交叉引用表损坏：扫描整个文件重建
		d.xref = map[int]xentry{}
		d.cache = map[int]any{}
		d.reconstruct()
	}
	if d.rootDict() == nil {
		return nil, errors.New("PDF 文件已损坏：找不到文档目录")
	}
	if enc, ok := d.resolve(d.trailer["Encrypt"]).(dict); ok {
		c, err := newDecrypter(enc, d.trailer)
		if err != nil {
			return nil, err
		}
		d.crypt = c
		d.cache = map[int]any{} // 之前读到的对象（如目录）还没解密
		d.objStms = map[int]*objStream{}
	}
	return d, nil
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func (d *document) rootDict() dict {
	r, _ := d.resolve(d.trailer["Root"]).(dict)
	return r
}

var startxrefRe = regexp.MustCompile(`startxref\s+(\d+)`)

func (d *document) loadXrefChain() error {
	tail := d.b
	if len(tail) > 4096 {
		tail = tail[len(tail)-4096:]
	}
	ms := startxrefRe.FindAllSubmatch(tail, -1)
	if len(ms) == 0 {
		return errors.New("no startxref")
	}
	off, _ := strconv.Atoi(string(ms[len(ms)-1][1]))
	seen := map[int]bool{}
	first := true
	for off > 0 && off < len(d.b) && !seen[off] && len(seen) < 100 {
		seen[off] = true
		tr, err := d.readXrefAt(off)
		if err != nil {
			if first {
				return err
			}
			break
		}
		if first {
			d.trailer = tr
			first = false
		}
		// 混合文件：trailer 里还有一个交叉引用流
		if xs := intOr(tr["XRefStm"], 0); xs > 0 && !seen[xs] {
			seen[xs] = true
			_, _ = d.readXrefAt(xs)
		}
		off = intOr(tr["Prev"], 0)
	}
	if d.trailer == nil {
		return errors.New("no trailer")
	}
	return nil
}

// readXrefAt 读一节交叉引用（表或流），已有的条目不覆盖（越新的越先读）
func (d *document) readXrefAt(off int) (dict, error) {
	l := &lexer{b: d.b, p: off}
	l.skipSpace()
	if bytes.HasPrefix(d.b[l.p:], []byte("xref")) {
		l.p += 4
		for {
			l.skipSpace()
			if bytes.HasPrefix(d.b[l.p:], []byte("trailer")) {
				l.p += 7
				tr, ok := l.object(0).(dict)
				if !ok {
					return nil, errors.New("bad trailer")
				}
				return tr, nil
			}
			start, err1 := strconv.Atoi(l.word())
			l.skipSpace()
			count, err2 := strconv.Atoi(l.word())
			if err1 != nil || err2 != nil || count < 0 || count > 10_000_000 {
				return nil, errors.New("bad xref subsection")
			}
			for i := 0; i < count; i++ {
				l.skipSpace()
				o, e1 := strconv.Atoi(l.word())
				l.skipSpace()
				g, e2 := strconv.Atoi(l.word())
				l.skipSpace()
				t := l.word()
				if e1 != nil || e2 != nil {
					return nil, errors.New("bad xref entry")
				}
				n := start + i
				if _, have := d.xref[n]; !have {
					if t == "n" {
						d.xref[n] = xentry{typ: 1, off: o, gen: g}
					} else {
						d.xref[n] = xentry{typ: 0}
					}
				}
			}
		}
	}
	// 交叉引用流
	n, _, v, err := d.parseIndirectAt(off)
	if err != nil {
		return nil, err
	}
	st, ok := v.(*stream)
	if !ok || st.dict["Type"] != name("XRef") {
		return nil, errors.New("not an xref stream")
	}
	_ = n
	data, err := d.decodeStream(st)
	if err != nil && len(data) == 0 {
		return nil, err
	}
	w, _ := st.dict["W"].(array)
	if len(w) != 3 {
		return nil, errors.New("bad /W")
	}
	ws := [3]int{intOr(w[0], 0), intOr(w[1], 0), intOr(w[2], 0)}
	if ws[0] < 0 || ws[1] < 0 || ws[2] < 0 || ws[0]+ws[1]+ws[2] == 0 {
		return nil, errors.New("bad /W")
	}
	index, _ := st.dict["Index"].(array)
	if len(index) == 0 {
		index = array{int64(0), st.dict["Size"]}
	}
	rowLen := ws[0] + ws[1] + ws[2]
	p := 0
	for i := 0; i+1 < len(index); i += 2 {
		start, count := intOr(index[i], 0), intOr(index[i+1], 0)
		for k := 0; k < count && p+rowLen <= len(data); k++ {
			field := func(j, from int) int {
				v := 0
				for _, c := range data[from : from+ws[j]] {
					v = v<<8 | int(c)
				}
				return v
			}
			typ := 1
			if ws[0] > 0 {
				typ = field(0, p)
			}
			f2 := field(1, p+ws[0])
			f3 := field(2, p+ws[0]+ws[1])
			p += rowLen
			num := start + k
			if _, have := d.xref[num]; have {
				continue
			}
			switch typ {
			case 1:
				d.xref[num] = xentry{typ: 1, off: f2, gen: f3}
			case 2:
				d.xref[num] = xentry{typ: 2, off: f2, index: f3}
			default:
				d.xref[num] = xentry{typ: 0}
			}
		}
	}
	return st.dict, nil
}

var objHeaderRe = regexp.MustCompile(`(\d+)[ \t\r\n\f\x00]+(\d+)[ \t\r\n\f\x00]+obj\b`)

// reconstruct 扫描整个文件找「n g obj」，后出现的覆盖先出现的
func (d *document) reconstruct() {
	for _, m := range objHeaderRe.FindAllSubmatchIndex(d.b, -1) {
		// 必须在行首或空白之后，避免匹配到字符串里
		if m[0] > 0 && !isWhite(d.b[m[0]-1]) {
			continue
		}
		n, _ := strconv.Atoi(string(d.b[m[2]:m[3]]))
		g, _ := strconv.Atoi(string(d.b[m[4]:m[5]]))
		d.xref[n] = xentry{typ: 1, off: m[0], gen: g}
	}
	// trailer：取最后一个带 /Root 的
	d.trailer = nil
	for i := 0; ; {
		k := bytes.Index(d.b[i:], []byte("trailer"))
		if k < 0 {
			break
		}
		l := &lexer{b: d.b, p: i + k + 7}
		if tr, ok := l.object(0).(dict); ok && tr["Root"] != nil {
			d.trailer = tr
		}
		i += k + 7
	}
	if d.trailer != nil && d.rootDict() != nil {
		return
	}
	// 没有 trailer（只有交叉引用流的文件）：找 /Type /XRef 的流或目录对象
	nums := make([]int, 0, len(d.xref))
	for n := range d.xref {
		nums = append(nums, n)
	}
	sort.Ints(nums)
	var catalog, encrypt any
	for _, n := range nums {
		v := d.getObject(n)
		if st, ok := v.(*stream); ok && st.dict["Type"] == name("XRef") {
			if st.dict["Root"] != nil {
				d.trailer = st.dict
			}
			if st.dict["Encrypt"] != nil {
				encrypt = st.dict["Encrypt"]
			}
		}
		if dd, ok := v.(dict); ok && dd["Type"] == name("Catalog") && catalog == nil {
			catalog = ref{n, d.xref[n].gen}
		}
	}
	if d.trailer == nil && catalog != nil {
		d.trailer = dict{"Root": catalog}
		if encrypt != nil {
			d.trailer["Encrypt"] = encrypt
		}
	}
	d.cache = map[int]any{}
}

// parseIndirectAt 解析偏移处的「n g obj ... endobj」
func (d *document) parseIndirectAt(off int) (int, int, any, error) {
	if off < 0 || off >= len(d.b) {
		return 0, 0, nil, fmt.Errorf("offset %d out of range", off)
	}
	l := &lexer{b: d.b, p: off}
	l.skipSpace()
	n, e1 := strconv.Atoi(l.word())
	l.skipSpace()
	g, e2 := strconv.Atoi(l.word())
	l.skipSpace()
	if e1 != nil || e2 != nil || l.word() != "obj" {
		return 0, 0, nil, fmt.Errorf("no object at %d", off)
	}
	v := l.object(0)
	if _, end := v.(endMark); end {
		return n, g, nil, nil
	}
	if dd, ok := v.(dict); ok {
		save := l.p
		l.skipSpace()
		if bytes.HasPrefix(d.b[l.p:], []byte("stream")) {
			l.p += 6
			if l.p < len(d.b) && d.b[l.p] == '\r' {
				l.p++
			}
			if l.p < len(d.b) && d.b[l.p] == '\n' {
				l.p++
			}
			start := l.p
			length := -1
			if ln, ok := dd["Length"].(ref); ok {
				if ln.num != n {
					length = intOr(d.resolve(ln), -1)
				}
			} else {
				length = intOr(dd["Length"], -1)
			}
			end := start + length
			if length < 0 || end > len(d.b) || !bytes.Contains(d.b[end:min(len(d.b), end+32)], []byte("endstream")) {
				// 长度不对：找 endstream
				k := bytes.Index(d.b[start:], []byte("endstream"))
				if k < 0 {
					end = len(d.b)
				} else {
					end = start + k
					for end > start && (d.b[end-1] == '\n' || d.b[end-1] == '\r') {
						end--
					}
				}
			}
			return n, g, &stream{dict: dd, raw: d.b[start:end]}, nil
		}
		l.p = save
	}
	return n, g, v, nil
}

// getObject 取间接对象（已解密）
func (d *document) getObject(n int) any {
	if v, ok := d.cache[n]; ok {
		return v
	}
	if d.loading[n] {
		return nil
	}
	d.loading[n] = true
	defer delete(d.loading, n)
	e, ok := d.xref[n]
	var v any
	switch {
	case !ok || e.typ == 0:
		v = nil
	case e.typ == 1:
		gotN, g, obj, err := d.parseIndirectAt(e.off)
		if err != nil || gotN != n {
			v = nil
		} else {
			v = obj
			if d.crypt != nil {
				v = d.decryptObject(v, n, g)
			}
		}
	case e.typ == 2:
		v = d.fromObjStream(e.off, n)
	}
	d.cache[n] = v
	return v
}

func (d *document) decryptObject(v any, n, g int) any {
	switch x := v.(type) {
	case []byte:
		return d.crypt.decryptString(x, n, g)
	case array:
		for i := range x {
			x[i] = d.decryptObject(x[i], n, g)
		}
		return x
	case dict:
		for k, vv := range x {
			x[k] = d.decryptObject(vv, n, g)
		}
		return x
	case *stream:
		// 交叉引用流本身不加密
		if x.dict["Type"] == name("XRef") {
			return x
		}
		for k, vv := range x.dict {
			x.dict[k] = d.decryptObject(vv, n, g)
		}
		if !(x.dict["Type"] == name("Metadata") && !d.crypt.encryptMetadata) {
			x.raw = d.crypt.decryptStream(x.raw, x.dict, n, g)
		}
		return x
	}
	return v
}

func (d *document) fromObjStream(stmNum, n int) any {
	os := d.objStms[stmNum]
	if os == nil {
		st, ok := d.getObject(stmNum).(*stream)
		if !ok {
			return nil
		}
		data, _ := d.decodeStream(st)
		first := intOr(st.dict["First"], 0)
		count := intOr(st.dict["N"], 0)
		os = &objStream{data: data, offs: map[int]int{}}
		l := &lexer{b: data}
		for i := 0; i < count && i < 1_000_000; i++ {
			l.skipSpace()
			on, e1 := strconv.Atoi(l.word())
			l.skipSpace()
			oo, e2 := strconv.Atoi(l.word())
			if e1 != nil || e2 != nil {
				break
			}
			os.offs[on] = first + oo
		}
		d.objStms[stmNum] = os
	}
	off, ok := os.offs[n]
	if !ok || off < 0 || off >= len(os.data) {
		return nil
	}
	l := &lexer{b: os.data, p: off}
	v := l.object(0)
	if _, end := v.(endMark); end {
		return nil
	}
	return v
}

// resolve 解开引用
func (d *document) resolve(v any) any {
	for i := 0; i < 32; i++ {
		r, ok := v.(ref)
		if !ok {
			return v
		}
		v = d.getObject(r.num)
	}
	return nil
}

func (d *document) dictOf(v any) dict {
	switch x := d.resolve(v).(type) {
	case dict:
		return x
	case *stream:
		return x.dict
	}
	return nil
}

func (d *document) arrayOf(v any) array {
	a, _ := d.resolve(v).(array)
	return a
}
