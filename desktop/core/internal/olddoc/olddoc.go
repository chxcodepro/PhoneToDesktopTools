package olddoc

import (
	"encoding/binary"
	"errors"
	"fmt"
)

// Document 读出的内容，三种只有一种非空
type Document struct {
	Kind   string     // word / excel / powerpoint
	Word   *wordParts // Word 文档各部分的文字
	Sheets []Sheet    // Excel 工作表
	Slides [][]string // 每张幻灯片的文字段落
}

// Read 按内容（而不是扩展名）识别并读取旧版 Office / WPS 文档。
func Read(b []byte) (doc *Document, err error) {
	defer func() {
		if r := recover(); r != nil {
			doc, err = nil, fmt.Errorf("文件格式异常，无法解析（%v）", r)
		}
	}()
	f, err := openCFB(b)
	if err != nil {
		return nil, err
	}
	switch {
	case f.has("EncryptionInfo") || f.has("EncryptedPackage"):
		// 加了密码的 docx / xlsx / pptx 也是复合文档
		return nil, ErrEncrypted
	case f.has("WordDocument"):
		w, err := readWord(f)
		if err != nil {
			return nil, err
		}
		return &Document{Kind: "word", Word: w}, nil
	case f.has("Workbook") || f.has("Book"):
		s, err := readXls(f)
		if err != nil {
			return nil, err
		}
		return &Document{Kind: "excel", Sheets: s}, nil
	case f.has("PowerPoint Document"):
		if cu, ok := f.stream("Current User"); ok && len(cu) >= 16 && binary.LittleEndian.Uint32(cu[12:]) == 0xF3D1C4DF {
			return nil, ErrEncrypted
		}
		s, err := readPpt(f)
		if err != nil {
			return nil, err
		}
		return &Document{Kind: "powerpoint", Slides: s}, nil
	}
	return nil, errors.New("无法识别的文档类型：不是 Word / Excel / PowerPoint 97-2003 格式")
}
