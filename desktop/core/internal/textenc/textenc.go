// Package textenc 处理中文环境常见的文本编码：UTF-8、带 BOM 的 UTF-8、GBK。
package textenc

import (
	"bytes"
	"unicode/utf8"

	"golang.org/x/text/encoding/simplifiedchinese"
)

// Encoding 文本编码。
type Encoding string

const (
	UTF8    Encoding = "utf-8"
	UTF8BOM Encoding = "utf-8-bom"
	GBK     Encoding = "gbk"
)

var bom = []byte{0xEF, 0xBB, 0xBF}

// IsBinary 粗略判断是否二进制文件（前 8KB 含 NUL）。
func IsBinary(b []byte) bool {
	if len(b) > 8192 {
		b = b[:8192]
	}
	return bytes.IndexByte(b, 0) >= 0
}

// Decode 识别编码并转为 UTF-8 字符串。
func Decode(b []byte) (string, Encoding) {
	if bytes.HasPrefix(b, bom) {
		return string(b[len(bom):]), UTF8BOM
	}
	if utf8.Valid(b) {
		return string(b), UTF8
	}
	out, err := simplifiedchinese.GBK.NewDecoder().Bytes(b)
	if err != nil {
		// 解码失败时按 UTF-8 尽量显示
		return string(bytes.ToValidUTF8(b, []byte("�"))), UTF8
	}
	return string(out), GBK
}

// Encode 把 UTF-8 字符串编码为指定编码。
func Encode(s string, enc Encoding) ([]byte, error) {
	switch enc {
	case GBK:
		return simplifiedchinese.GBK.NewEncoder().Bytes([]byte(s))
	case UTF8BOM:
		return append(append([]byte{}, bom...), s...), nil
	default:
		return []byte(s), nil
	}
}
