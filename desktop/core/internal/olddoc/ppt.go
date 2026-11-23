package olddoc

import (
	"encoding/binary"
	"errors"
	"strings"
	"unicode/utf16"
)

// PowerPoint 97-2003（[MS-PPT]）：「PowerPoint Document」流由记录树组成。
// 幻灯片的标题和正文（占位符）在 SlideListWithText 里，文本框、表格的文字在各幻灯片自己的容器里。

const (
	rtDocument          = 0x03E8
	rtSlide             = 0x03EE
	rtMainMaster        = 0x03F8
	rtNotes             = 0x03F0
	rtSlideListWithText = 0x0FF0
	rtSlidePersistAtom  = 0x03F3
	rtTextCharsAtom     = 0x0FA0
	rtTextBytesAtom     = 0x0FA8
	rtUserEditAtom      = 0x0FF5
	rtPersistDirectory  = 0x1772
)

type pptRec struct {
	ver, inst uint16
	typ       uint16
	body      []byte
}

// pptChildren 解析一段数据里的同级记录
func pptChildren(b []byte) []pptRec {
	le := binary.LittleEndian
	var out []pptRec
	for p := 0; p+8 <= len(b); {
		vi := le.Uint16(b[p:])
		typ := le.Uint16(b[p+2:])
		n := int(le.Uint32(b[p+4:]))
		if n < 0 || p+8+n > len(b) {
			n = len(b) - p - 8
		}
		out = append(out, pptRec{vi & 0x0F, vi >> 4, typ, b[p+8 : p+8+n]})
		p += 8 + n
	}
	return out
}

func pptRecAt(b []byte, off int) (pptRec, bool) {
	if off < 0 || off+8 > len(b) {
		return pptRec{}, false
	}
	rs := pptChildren(b[off:])
	if len(rs) == 0 {
		return pptRec{}, false
	}
	return rs[0], true
}

func atomText(r pptRec) string {
	var s string
	switch r.typ {
	case rtTextCharsAtom:
		units := make([]uint16, 0, len(r.body)/2)
		for i := 0; i+1 < len(r.body); i += 2 {
			units = append(units, binary.LittleEndian.Uint16(r.body[i:]))
		}
		s = string(utf16.Decode(units))
	case rtTextBytesAtom:
		rs := make([]rune, len(r.body))
		for i, c := range r.body {
			rs[i] = rune(c)
		}
		s = string(rs)
	default:
		return ""
	}
	s = strings.NewReplacer("\r", "\n", "\v", "\n").Replace(s)
	return strings.TrimSpace(s)
}

// maxPptText 最多收集的文字字节数。多张幻灯片可以指向同一个容器，不设上限会被放大。
const maxPptText = 8 << 20

// collectText 递归收集容器里的所有文字记录；left 是剩余额度
func collectText(b []byte, depth int, out *[]string, left *int) {
	if depth > 32 || *left <= 0 {
		return
	}
	for _, r := range pptChildren(b) {
		if *left <= 0 {
			return
		}
		if r.ver == 0x0F {
			if r.typ == rtMainMaster || r.typ == rtNotes {
				continue
			}
			collectText(r.body, depth+1, out, left)
			continue
		}
		if t := atomText(r); t != "" {
			*out = append(*out, t)
			*left -= len(t)
		}
	}
}

func readPpt(f *cfbFile) ([][]string, error) {
	doc, ok := f.stream("PowerPoint Document")
	if !ok {
		return nil, errors.New("不是 PowerPoint 文档（缺少 PowerPoint Document）")
	}
	if f.has("EncryptedSummary") {
		return nil, ErrEncrypted
	}
	if slides, ok := pptBySlides(f, doc); ok {
		return slides, nil
	}
	// 结构解析失败：按顺序收集全部文字，当成一页
	var all []string
	left := maxPptText
	collectText(doc, 0, &all, &left)
	if len(all) == 0 {
		return nil, nil
	}
	return [][]string{dedupe(all)}, nil
}

// pptBySlides 通过「当前用户 → 编辑记录 → 持久化目录」找到每张幻灯片
func pptBySlides(f *cfbFile, doc []byte) ([][]string, bool) {
	le := binary.LittleEndian
	cu, ok := f.stream("Current User")
	if !ok || len(cu) < 20 {
		return nil, false
	}
	offEdit := int(le.Uint32(cu[16:]))
	persist := map[uint32]int{}
	docRef := uint32(0)
	seen := map[int]bool{}
	for offEdit > 0 && !seen[offEdit] && len(seen) < 1000 {
		seen[offEdit] = true
		ue, ok := pptRecAt(doc, offEdit)
		if !ok || ue.typ != rtUserEditAtom || len(ue.body) < 20 {
			return nil, false
		}
		if docRef == 0 {
			docRef = le.Uint32(ue.body[16:])
		}
		pd, ok := pptRecAt(doc, int(le.Uint32(ue.body[12:])))
		if ok && pd.typ == rtPersistDirectory {
			b := pd.body
			for p := 0; p+4 <= len(b); {
				h := le.Uint32(b[p:])
				id, n := h&0xFFFFF, int(h>>20)
				p += 4
				for k := 0; k < n && p+4 <= len(b); k++ {
					if _, have := persist[id+uint32(k)]; !have { // 新的编辑优先
						persist[id+uint32(k)] = int(le.Uint32(b[p:]))
					}
					p += 4
				}
			}
		}
		offEdit = int(le.Uint32(ue.body[8:]))
	}
	docRec, ok := pptRecAt(doc, persist[docRef])
	if !ok || docRec.typ != rtDocument {
		return nil, false
	}
	var slides [][]string
	found := false
	left := maxPptText
	for _, r := range pptChildren(docRec.body) {
		if r.typ != rtSlideListWithText || r.inst != 0 {
			continue
		}
		found = true
		var cur *[]string
		var curRef uint32
		finish := func() {
			if cur == nil {
				return
			}
			// 幻灯片自己的文本框、表格
			if sr, ok := pptRecAt(doc, persist[curRef]); ok && sr.typ == rtSlide {
				collectText(sr.body, 0, cur, &left)
			}
			slides = append(slides, dedupe(*cur))
		}
		for _, c := range pptChildren(r.body) {
			switch {
			case c.typ == rtSlidePersistAtom && len(c.body) >= 4:
				finish()
				cur = &[]string{}
				curRef = le.Uint32(c.body)
			case cur != nil && left > 0:
				if t := atomText(c); t != "" {
					*cur = append(*cur, t)
					left -= len(t)
				}
			}
		}
		finish()
	}
	return slides, found
}

func dedupe(list []string) []string {
	seen := map[string]bool{}
	out := list[:0]
	for _, s := range list {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}
