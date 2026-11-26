package usbmux

// usbmuxd 的消息是 XML 格式的属性列表（plist）。这里只实现用得到的部分：
// 编码 dict（字符串、整数、布尔），解码 dict / array / string / integer / real / true / false / data / date。

import (
	"bytes"
	"encoding/base64"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"sort"
	"strconv"
	"strings"
)

// encodePlist 把一层 dict 编码成 XML plist（键按字母排序，便于测试）
func encodePlist(m map[string]any) ([]byte, error) {
	var b bytes.Buffer
	b.WriteString(`<?xml version="1.0" encoding="UTF-8"?>` + "\n")
	b.WriteString(`<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">` + "\n")
	b.WriteString(`<plist version="1.0">` + "\n")
	if err := writeValue(&b, m); err != nil {
		return nil, err
	}
	b.WriteString("</plist>\n")
	return b.Bytes(), nil
}

func writeValue(b *bytes.Buffer, v any) error {
	switch x := v.(type) {
	case map[string]any:
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		b.WriteString("<dict>\n")
		for _, k := range keys {
			b.WriteString("<key>")
			_ = xml.EscapeText(b, []byte(k))
			b.WriteString("</key>\n")
			if err := writeValue(b, x[k]); err != nil {
				return err
			}
		}
		b.WriteString("</dict>\n")
	case string:
		b.WriteString("<string>")
		_ = xml.EscapeText(b, []byte(x))
		b.WriteString("</string>\n")
	case int:
		fmt.Fprintf(b, "<integer>%d</integer>\n", x)
	case int64:
		fmt.Fprintf(b, "<integer>%d</integer>\n", x)
	case uint64:
		fmt.Fprintf(b, "<integer>%d</integer>\n", x)
	case bool:
		if x {
			b.WriteString("<true/>\n")
		} else {
			b.WriteString("<false/>\n")
		}
	case []byte:
		b.WriteString("<data>" + base64.StdEncoding.EncodeToString(x) + "</data>\n")
	default:
		return fmt.Errorf("plist：不支持的类型 %T", v)
	}
	return nil
}

// decodePlist 解码 XML plist，返回顶层的值（usbmuxd 的回复都是 dict）
func decodePlist(data []byte) (any, error) {
	d := xml.NewDecoder(bytes.NewReader(data))
	d.Strict = false
	for {
		tok, err := d.Token()
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil, errors.New("plist：没有内容")
			}
			return nil, err
		}
		if se, ok := tok.(xml.StartElement); ok && se.Name.Local != "plist" {
			return readValue(d, se)
		}
	}
}

// readValue 读取以 se 开头的一个值（读到对应的结束标签为止）
func readValue(d *xml.Decoder, se xml.StartElement) (any, error) {
	switch se.Name.Local {
	case "dict":
		m := map[string]any{}
		key := ""
		for {
			tok, err := d.Token()
			if err != nil {
				return nil, err
			}
			switch t := tok.(type) {
			case xml.StartElement:
				if t.Name.Local == "key" {
					s, err := readText(d)
					if err != nil {
						return nil, err
					}
					key = s
					continue
				}
				v, err := readValue(d, t)
				if err != nil {
					return nil, err
				}
				m[key] = v
			case xml.EndElement:
				return m, nil
			}
		}
	case "array":
		var arr []any
		for {
			tok, err := d.Token()
			if err != nil {
				return nil, err
			}
			switch t := tok.(type) {
			case xml.StartElement:
				v, err := readValue(d, t)
				if err != nil {
					return nil, err
				}
				arr = append(arr, v)
			case xml.EndElement:
				return arr, nil
			}
		}
	case "true", "false":
		if err := d.Skip(); err != nil {
			return nil, err
		}
		return se.Name.Local == "true", nil
	case "integer":
		s, err := readText(d)
		if err != nil {
			return nil, err
		}
		return strconv.ParseInt(strings.TrimSpace(s), 10, 64)
	case "real":
		s, err := readText(d)
		if err != nil {
			return nil, err
		}
		return strconv.ParseFloat(strings.TrimSpace(s), 64)
	case "data":
		s, err := readText(d)
		if err != nil {
			return nil, err
		}
		return base64.StdEncoding.DecodeString(strings.Join(strings.Fields(s), ""))
	default: // string、date 等按文本处理
		return readText(d)
	}
}

// readText 读取元素内的文本，直到它的结束标签
func readText(d *xml.Decoder) (string, error) {
	var sb strings.Builder
	depth := 0
	for {
		tok, err := d.Token()
		if err != nil {
			return "", err
		}
		switch t := tok.(type) {
		case xml.CharData:
			sb.Write(t)
		case xml.StartElement:
			depth++
		case xml.EndElement:
			if depth == 0 {
				return sb.String(), nil
			}
			depth--
		}
	}
}

// 从解码结果里取值的小工具

func dictOf(v any) map[string]any {
	m, _ := v.(map[string]any)
	return m
}

func intOf(v any) (int64, bool) {
	switch x := v.(type) {
	case int64:
		return x, true
	case float64:
		return int64(x), true
	}
	return 0, false
}

func stringOf(v any) string {
	s, _ := v.(string)
	return s
}
