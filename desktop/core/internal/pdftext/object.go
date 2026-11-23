// Package pdftext 从 PDF 文件里提取文字。纯 Go 实现，不依赖第三方程序，
// 支持压缩对象流、交叉引用流、标准加密（空打开密码）、ToUnicode 与常见中文编码。
package pdftext

import (
	"bytes"
	"strconv"
)

// PDF 对象类型：nil（null）、bool、int64、float64、name、[]byte（字符串）、
// array、dict、ref、*stream、keyword（内容流里的操作符等）。
type (
	name    string
	keyword string
	array   []any
	dict    map[string]any
	ref     struct{ num, gen int }
	stream  struct {
		dict dict
		raw  []byte // 文件里的原始数据（已解密，未解压）
	}
)

func isWhite(c byte) bool {
	return c == ' ' || c == '\n' || c == '\r' || c == '\t' || c == '\f' || c == 0
}

func isDelim(c byte) bool {
	switch c {
	case '(', ')', '<', '>', '[', ']', '{', '}', '/', '%':
		return true
	}
	return false
}

// lexer 在一段字节上读取 PDF 语法的对象。
type lexer struct {
	b []byte
	p int
}

func (l *lexer) eof() bool { return l.p >= len(l.b) }

func (l *lexer) skipSpace() {
	for l.p < len(l.b) {
		c := l.b[l.p]
		if isWhite(c) {
			l.p++
		} else if c == '%' {
			for l.p < len(l.b) && l.b[l.p] != '\n' && l.b[l.p] != '\r' {
				l.p++
			}
		} else {
			return
		}
	}
}

// word 读取一个普通词（数字、关键字）
func (l *lexer) word() string {
	s := l.p
	for l.p < len(l.b) && !isWhite(l.b[l.p]) && !isDelim(l.b[l.p]) {
		l.p++
	}
	return string(l.b[s:l.p])
}

// errEnd 读到结尾或遇到结束符号（] 或 >>）
type endMark byte

// object 读取一个对象；数字后面跟着「数字 R」时读成引用。
func (l *lexer) object(depth int) any {
	l.skipSpace()
	if l.eof() {
		return endMark(0)
	}
	if depth > 200 {
		l.p++ // 嵌套过深：丢弃一个字节，保证一定往前走
		return nil
	}
	c := l.b[l.p]
	switch c {
	case '/':
		l.p++
		s := l.p
		for l.p < len(l.b) && !isWhite(l.b[l.p]) && !isDelim(l.b[l.p]) {
			l.p++
		}
		return name(unescapeName(l.b[s:l.p]))
	case '(':
		l.p++
		return l.literal()
	case '<':
		if l.p+1 < len(l.b) && l.b[l.p+1] == '<' {
			l.p += 2
			d := dict{}
			for {
				k := l.object(depth + 1)
				if e, ok := k.(endMark); ok {
					if e == '>' {
						l.p += 2
					}
					return d
				}
				kn, ok := k.(name)
				if !ok {
					continue // 容错：跳过非名称的键
				}
				v := l.object(depth + 1)
				if e, ok := v.(endMark); ok {
					if e == '>' {
						l.p += 2
					}
					d[string(kn)] = nil
					return d
				}
				d[string(kn)] = v
			}
		}
		l.p++
		return l.hexString()
	case '>':
		if l.p+1 < len(l.b) && l.b[l.p+1] == '>' {
			return endMark('>')
		}
		l.p++
		return l.object(depth)
	case '[':
		l.p++
		var a array
		for {
			v := l.object(depth + 1)
			if e, ok := v.(endMark); ok {
				if e == ']' {
					l.p++
				}
				return a
			}
			a = append(a, v)
		}
	case ']':
		return endMark(']')
	case ')', '{', '}':
		l.p++
		return l.object(depth)
	}
	w := l.word()
	if w == "" {
		l.p++
		return l.object(depth)
	}
	if n, ok := parseNumber(w); ok {
		if i, isInt := n.(int64); isInt && i >= 0 {
			// 可能是「num gen R」
			save := l.p
			l.skipSpace()
			g := l.word()
			if gi, err := strconv.Atoi(g); err == nil && gi >= 0 {
				l.skipSpace()
				if l.p < len(l.b) && l.b[l.p] == 'R' && (l.p+1 == len(l.b) || isWhite(l.b[l.p+1]) || isDelim(l.b[l.p+1])) {
					l.p++
					return ref{int(i), gi}
				}
			}
			l.p = save
		}
		return n
	}
	switch w {
	case "true":
		return true
	case "false":
		return false
	case "null":
		return nil
	}
	return keyword(w)
}

func parseNumber(w string) (any, bool) {
	c := w[0]
	if !(c >= '0' && c <= '9' || c == '-' || c == '+' || c == '.') {
		return nil, false
	}
	if i, err := strconv.ParseInt(w, 10, 64); err == nil {
		return i, true
	}
	if f, err := strconv.ParseFloat(w, 64); err == nil {
		return f, true
	}
	// 容错：「--5」「5.-」之类的写法
	clean := bytes.Trim([]byte(w), "+-.")
	if f, err := strconv.ParseFloat(string(clean), 64); err == nil {
		if c == '-' {
			f = -f
		}
		return f, true
	}
	return nil, false
}

func unescapeName(b []byte) string {
	if bytes.IndexByte(b, '#') < 0 {
		return string(b)
	}
	out := make([]byte, 0, len(b))
	for i := 0; i < len(b); i++ {
		if b[i] == '#' && i+2 < len(b) {
			if v, err := strconv.ParseUint(string(b[i+1:i+3]), 16, 8); err == nil {
				out = append(out, byte(v))
				i += 2
				continue
			}
		}
		out = append(out, b[i])
	}
	return string(out)
}

func (l *lexer) literal() []byte {
	var out []byte
	depth := 1
	for l.p < len(l.b) {
		c := l.b[l.p]
		l.p++
		switch c {
		case '(':
			depth++
			out = append(out, c)
		case ')':
			depth--
			if depth == 0 {
				return out
			}
			out = append(out, c)
		case '\\':
			if l.p >= len(l.b) {
				return out
			}
			e := l.b[l.p]
			l.p++
			switch e {
			case 'n':
				out = append(out, '\n')
			case 'r':
				out = append(out, '\r')
			case 't':
				out = append(out, '\t')
			case 'b':
				out = append(out, '\b')
			case 'f':
				out = append(out, '\f')
			case '\r':
				if l.p < len(l.b) && l.b[l.p] == '\n' {
					l.p++
				}
			case '\n':
			default:
				if e >= '0' && e <= '7' {
					v := int(e - '0')
					for k := 0; k < 2 && l.p < len(l.b) && l.b[l.p] >= '0' && l.b[l.p] <= '7'; k++ {
						v = v*8 + int(l.b[l.p]-'0')
						l.p++
					}
					out = append(out, byte(v))
				} else {
					out = append(out, e)
				}
			}
		default:
			out = append(out, c)
		}
	}
	return out
}

func (l *lexer) hexString() []byte {
	var out []byte
	hi, have := byte(0), false
	for l.p < len(l.b) {
		c := l.b[l.p]
		l.p++
		if c == '>' {
			break
		}
		v, ok := hexVal(c)
		if !ok {
			continue
		}
		if have {
			out = append(out, hi<<4|v)
			have = false
		} else {
			hi, have = v, true
		}
	}
	if have {
		out = append(out, hi<<4)
	}
	return out
}

func hexVal(c byte) (byte, bool) {
	switch {
	case c >= '0' && c <= '9':
		return c - '0', true
	case c >= 'a' && c <= 'f':
		return c - 'a' + 10, true
	case c >= 'A' && c <= 'F':
		return c - 'A' + 10, true
	}
	return 0, false
}

// ---------- 取值辅助 ----------

func num(v any) (float64, bool) {
	switch x := v.(type) {
	case int64:
		return float64(x), true
	case float64:
		return x, true
	}
	return 0, false
}

func numOr(v any, def float64) float64 {
	if f, ok := num(v); ok {
		return f
	}
	return def
}

func intOr(v any, def int) int {
	if f, ok := num(v); ok {
		return int(f)
	}
	return def
}
