package pdftext

import (
	"bytes"
	"compress/flate"
	"compress/zlib"
	"errors"
	"fmt"
	"io"
)

// maxDecoded 单个流解压后的上限，防止压缩炸弹
const maxDecoded = 64 << 20

// decodeStream 按 /Filter 依次解码。出错时尽量返回已解出的部分。
func (d *document) decodeStream(st *stream) ([]byte, error) {
	filters := []any{}
	switch f := d.resolve(st.dict["Filter"]).(type) {
	case name:
		filters = append(filters, f)
	case array:
		filters = append(filters, f...)
	}
	var parms []any
	switch p := d.resolve(st.dict["DecodeParms"]).(type) {
	case dict:
		parms = []any{p}
	case array:
		parms = p
	}
	data := st.raw
	for i, f := range filters {
		var parm dict
		if i < len(parms) {
			parm = d.dictOf(parms[i])
		}
		fn, _ := d.resolve(f).(name)
		var err error
		data, err = applyFilter(string(fn), data, parm)
		if err != nil {
			return data, err
		}
	}
	return data, nil
}

func applyFilter(f string, data []byte, parm dict) ([]byte, error) {
	switch f {
	case "FlateDecode", "Fl":
		out, err := inflate(data)
		if len(out) == 0 && err != nil {
			return nil, err
		}
		return predict(out, parm)
	case "LZWDecode", "LZW":
		early := 1
		if parm != nil {
			early = intOr(parm["EarlyChange"], 1)
		}
		out := lzwDecode(data, early == 1)
		return predict(out, parm)
	case "ASCIIHexDecode", "AHx":
		l := &lexer{b: append(append([]byte{}, data...), '>')}
		return l.hexString(), nil
	case "ASCII85Decode", "A85":
		return ascii85(data), nil
	case "RunLengthDecode", "RL":
		return runLength(data), nil
	case "Crypt":
		return data, nil // 已在读取对象时解密
	}
	return nil, fmt.Errorf("不支持的压缩方式 %s", f)
}

func inflate(data []byte) ([]byte, error) {
	var r io.Reader
	zr, err := zlib.NewReader(bytes.NewReader(data))
	if err == nil {
		r = zr
	} else {
		// 有的文件省略了 zlib 头
		r = flate.NewReader(bytes.NewReader(data))
	}
	out, err := io.ReadAll(io.LimitReader(r, maxDecoded))
	if err != nil && len(out) == 0 && len(data) > 2 {
		// 再试一次跳过 2 字节头的原始 deflate
		out2, err2 := io.ReadAll(io.LimitReader(flate.NewReader(bytes.NewReader(data[2:])), maxDecoded))
		if len(out2) > 0 {
			return out2, nil
		}
		return nil, err2
	}
	// 数据尾部损坏（常见）：保留已解出的部分
	return out, nil
}

// predict 处理 PNG / TIFF 预测器
func predict(data []byte, parm dict) ([]byte, error) {
	if parm == nil {
		return data, nil
	}
	pred := intOr(parm["Predictor"], 1)
	if pred < 2 {
		return data, nil
	}
	colors := intOr(parm["Colors"], 1)
	bpc := intOr(parm["BitsPerComponent"], 8)
	cols := intOr(parm["Columns"], 1)
	if colors < 1 || bpc < 1 || cols < 1 || colors*bpc*cols > 1<<24 {
		return data, errors.New("bad predictor parameters")
	}
	bpp := (colors*bpc + 7) / 8
	row := (colors*bpc*cols + 7) / 8
	if pred == 2 {
		if bpc != 8 {
			return data, nil
		}
		out := append([]byte{}, data...)
		for r := 0; r+row <= len(out); r += row {
			for i := bpp; i < row; i++ {
				out[r+i] += out[r+i-bpp]
			}
		}
		return out, nil
	}
	// PNG：每行前一个字节是过滤类型
	out := make([]byte, 0, len(data))
	prev := make([]byte, row)
	for p := 0; p+1 <= len(data); {
		ft := data[p]
		p++
		n := row
		if p+n > len(data) {
			n = len(data) - p
		}
		cur := make([]byte, row)
		copy(cur, data[p:p+n])
		p += n
		for i := 0; i < row; i++ {
			var a, b, c byte
			if i >= bpp {
				a = cur[i-bpp]
				c = prev[i-bpp]
			}
			b = prev[i]
			switch ft {
			case 1:
				cur[i] += a
			case 2:
				cur[i] += b
			case 3:
				cur[i] += byte((int(a) + int(b)) / 2)
			case 4:
				cur[i] += paeth(a, b, c)
			}
		}
		out = append(out, cur[:n]...)
		prev = cur
	}
	return out, nil
}

func paeth(a, b, c byte) byte {
	p := int(a) + int(b) - int(c)
	pa, pb, pc := abs(p-int(a)), abs(p-int(b)), abs(p-int(c))
	if pa <= pb && pa <= pc {
		return a
	}
	if pb <= pc {
		return b
	}
	return c
}

func abs(x int) int {
	if x < 0 {
		return -x
	}
	return x
}

func ascii85(data []byte) []byte {
	var out []byte
	var group [5]byte
	n := 0
	flush := func(cnt int) {
		var v uint32
		for i := 0; i < 5; i++ {
			c := byte('u')
			if i < cnt {
				c = group[i]
			}
			v = v*85 + uint32(c-'!')
		}
		b := []byte{byte(v >> 24), byte(v >> 16), byte(v >> 8), byte(v)}
		out = append(out, b[:cnt-1]...)
	}
	for i := 0; i < len(data); i++ {
		c := data[i]
		if c == '~' {
			break
		}
		if isWhite(c) {
			continue
		}
		if c == 'z' && n == 0 {
			out = append(out, 0, 0, 0, 0)
			continue
		}
		if c < '!' || c > 'u' {
			continue
		}
		group[n] = c
		n++
		if n == 5 {
			flush(5)
			n = 0
		}
	}
	if n > 1 {
		flush(n)
	}
	return out
}

func runLength(data []byte) []byte {
	var out []byte
	for i := 0; i < len(data); {
		l := int(data[i])
		i++
		switch {
		case l < 128:
			end := i + l + 1
			if end > len(data) {
				end = len(data)
			}
			out = append(out, data[i:end]...)
			i = end
		case l > 128:
			if i < len(data) {
				for k := 0; k < 257-l; k++ {
					out = append(out, data[i])
				}
			}
			i++
		default:
			return out
		}
	}
	return out
}

// lzwDecode PDF 的 LZW（高位在前，默认 EarlyChange = 1）
func lzwDecode(data []byte, early bool) []byte {
	var out []byte
	table := make([][]byte, 4096)
	reset := func() int {
		for i := 0; i < 256; i++ {
			table[i] = []byte{byte(i)}
		}
		return 258
	}
	next := reset()
	width := 9
	var bitBuf uint32
	bits := 0
	var prev []byte
	off := 0
	if early {
		off = 1
	}
	for i := 0; i < len(data); i++ {
		bitBuf = bitBuf<<8 | uint32(data[i])
		bits += 8
		for bits >= width {
			code := int(bitBuf>>(bits-width)) & (1<<width - 1)
			bits -= width
			switch {
			case code == 256:
				next = reset()
				width = 9
				prev = nil
				continue
			case code == 257:
				return out
			}
			var entry []byte
			if code < next && table[code] != nil {
				entry = table[code]
			} else if code == next && prev != nil {
				entry = append(append([]byte{}, prev...), prev[0])
			} else {
				return out
			}
			out = append(out, entry...)
			if len(out) > maxDecoded {
				return out
			}
			if prev != nil && next < 4096 {
				table[next] = append(append([]byte{}, prev...), entry[0])
				next++
			}
			prev = entry
			if next+off >= 1<<width && width < 12 {
				width++
			}
		}
	}
	return out
}
