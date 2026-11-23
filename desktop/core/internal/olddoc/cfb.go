// Package olddoc 读取旧版 Office 二进制文档（Word 97-2003 .doc、Excel 97-2003 .xls、PowerPoint 97-2003 .ppt，
// 以及 WPS 的 .wps / .et / .dps）的文字。纯 Go 实现。
package olddoc

import (
	"bytes"
	"encoding/binary"
	"errors"
	"strings"
	"unicode/utf16"
)

// 复合文档（Compound File Binary，[MS-CFB]）

var cfbMagic = []byte{0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1}

const (
	secFree     = 0xFFFFFFFF
	secEnd      = 0xFFFFFFFE
	maxSectorID = 0xFFFFFFFA
)

// IsCFB 是否是复合文档
func IsCFB(b []byte) bool { return len(b) >= 512 && bytes.Equal(b[:8], cfbMagic) }

type cfbFile struct {
	b          []byte
	secSize    int
	fat        []uint32
	miniFAT    []uint32
	miniStream []byte
	cutoff     uint32
	entries    []dirEntry
}

type dirEntry struct {
	name               string
	typ                byte // 1 存储，2 流，5 根
	start              uint32
	size               uint64
	left, right, child uint32
}

var errBadCFB = errors.New("文件已损坏：复合文档结构不完整")

func openCFB(b []byte) (*cfbFile, error) {
	if !IsCFB(b) {
		return nil, errors.New("不是 Office 97-2003 格式的文件")
	}
	le := binary.LittleEndian
	shift := le.Uint16(b[0x1E:])
	if shift != 9 && shift != 12 {
		return nil, errBadCFB
	}
	f := &cfbFile{b: b, secSize: 1 << shift, cutoff: le.Uint32(b[0x38:])}
	if f.cutoff == 0 {
		f.cutoff = 4096
	}
	// FAT 扇区列表：头部的 109 个 + DIFAT 链
	var fatSecs []uint32
	for i := 0; i < 109; i++ {
		if s := le.Uint32(b[0x4C+i*4:]); s <= maxSectorID {
			fatSecs = append(fatSecs, s)
		}
	}
	difat := le.Uint32(b[0x44:])
	for n := 0; difat <= maxSectorID && n < 10000; n++ {
		sec := f.sector(difat)
		if sec == nil {
			break
		}
		per := f.secSize/4 - 1
		for i := 0; i < per; i++ {
			if s := le.Uint32(sec[i*4:]); s <= maxSectorID {
				fatSecs = append(fatSecs, s)
			}
		}
		difat = le.Uint32(sec[per*4:])
	}
	for _, s := range fatSecs {
		sec := f.sector(s)
		if sec == nil {
			continue
		}
		for i := 0; i+4 <= len(sec); i += 4 {
			f.fat = append(f.fat, le.Uint32(sec[i:]))
		}
	}
	if len(f.fat) == 0 {
		return nil, errBadCFB
	}
	// 目录
	dir := f.chain(le.Uint32(b[0x30:]), f.fat, f.secSize, func(s uint32) []byte { return f.sector(s) }, 0)
	for i := 0; i+128 <= len(dir); i += 128 {
		e := dir[i : i+128]
		nl := int(le.Uint16(e[0x40:]))
		if nl > 64 {
			nl = 64
		}
		units := make([]uint16, 0, 32)
		for k := 0; k+1 < nl; k += 2 {
			if u := le.Uint16(e[k:]); u != 0 {
				units = append(units, u)
			}
		}
		de := dirEntry{name: string(utf16.Decode(units)), typ: e[0x42], start: le.Uint32(e[0x74:]), size: le.Uint64(e[0x78:]),
			left: le.Uint32(e[0x44:]), right: le.Uint32(e[0x48:]), child: le.Uint32(e[0x4C:])}
		if f.secSize == 512 {
			de.size &= 0xFFFFFFFF // v3 文件高 32 位可能是垃圾
		}
		f.entries = append(f.entries, de)
	}
	if len(f.entries) == 0 || f.entries[0].typ != 5 {
		return nil, errBadCFB
	}
	// 迷你流和迷你 FAT
	root := f.entries[0]
	f.miniStream = f.chain(root.start, f.fat, f.secSize, func(s uint32) []byte { return f.sector(s) }, root.size)
	mf := f.chain(le.Uint32(b[0x3C:]), f.fat, f.secSize, func(s uint32) []byte { return f.sector(s) }, 0)
	for i := 0; i+4 <= len(mf); i += 4 {
		f.miniFAT = append(f.miniFAT, le.Uint32(mf[i:]))
	}
	return f, nil
}

func (f *cfbFile) sector(s uint32) []byte {
	off := (int(s) + 1) * f.secSize
	if s > maxSectorID || off < 0 || off >= len(f.b) {
		return nil
	}
	end := off + f.secSize
	if end > len(f.b) {
		end = len(f.b) // 最后一个扇区不完整（常见于截断的文件）
	}
	return f.b[off:end]
}

func (f *cfbFile) miniSector(s uint32) []byte {
	off := int(s) * 64
	if s > maxSectorID || off < 0 || off >= len(f.miniStream) {
		return nil
	}
	end := off + 64
	if end > len(f.miniStream) {
		end = len(f.miniStream)
	}
	return f.miniStream[off:end]
}

// chain 沿分配表读出一条扇区链；size > 0 时截到这个长度
func (f *cfbFile) chain(start uint32, table []uint32, secSize int, get func(uint32) []byte, size uint64) []byte {
	var out []byte
	seen := map[uint32]bool{}
	for s := start; s <= maxSectorID && !seen[s]; {
		seen[s] = true
		sec := get(s)
		if sec == nil {
			break
		}
		out = append(out, sec...)
		if size > 0 && uint64(len(out)) >= size {
			break
		}
		if int(s) >= len(table) {
			break
		}
		s = table[s]
	}
	if size > 0 && uint64(len(out)) > size {
		out = out[:size]
	}
	return out
}

// rootChildren 根存储下的直接子项（目录是红黑树：child 指向一个子项，left / right 是同级）。
// 嵌入对象（ObjectPool 里的 Word / Excel 等）有同名的流，只能在根下找。
func (f *cfbFile) rootChildren() []dirEntry {
	var out []dirEntry
	seen := map[uint32]bool{}
	stack := []uint32{f.entries[0].child}
	for len(stack) > 0 && len(seen) < len(f.entries) {
		id := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if id > maxSectorID || int(id) >= len(f.entries) || seen[id] {
			continue
		}
		seen[id] = true
		e := f.entries[id]
		out = append(out, e)
		stack = append(stack, e.left, e.right)
	}
	return out
}

// stream 按名称取根目录下的流（不区分大小写）
func (f *cfbFile) stream(name string) ([]byte, bool) {
	for _, e := range f.rootChildren() {
		if e.typ != 2 || !strings.EqualFold(e.name, name) {
			continue
		}
		if e.size < uint64(f.cutoff) {
			return f.chain(e.start, f.miniFAT, 64, f.miniSector, e.size), true
		}
		return f.chain(e.start, f.fat, f.secSize, func(s uint32) []byte { return f.sector(s) }, e.size), true
	}
	return nil, false
}

func (f *cfbFile) has(name string) bool {
	for _, e := range f.rootChildren() {
		if strings.EqualFold(e.name, name) {
			return true
		}
	}
	return false
}
