package olddoc

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"os"
	"runtime"
	"strings"
	"testing"
	"time"
	"unicode/utf16"
)

// ---------- 测试用的最小复合文档生成器（v3，512 字节扇区，流都放在普通扇区里） ----------

type cfbStream struct {
	name string
	data []byte
}

func buildCFB(streams []cfbStream) []byte {
	const ss = 512
	le := binary.LittleEndian
	secs := func(n int) int { return (n + ss - 1) / ss }
	// 小于 4096 字节的流放进迷你流（64 字节一个迷你扇区）
	var mini []byte
	var miniFAT []uint32
	miniStart := make([]int, len(streams))
	for i, s := range streams {
		if len(s.data) >= 4096 {
			continue
		}
		first := len(mini) / 64
		n := (len(s.data) + 63) / 64
		miniStart[i] = first
		for k := 0; k < n; k++ {
			if k == n-1 {
				miniFAT = append(miniFAT, secEnd)
			} else {
				miniFAT = append(miniFAT, uint32(first+k+1))
			}
		}
		buf := make([]byte, n*64)
		copy(buf, s.data)
		mini = append(mini, buf...)
	}
	var miniFATBytes []byte
	for _, v := range miniFAT {
		miniFATBytes = le.AppendUint32(miniFATBytes, v)
	}
	// 普通扇区里依次放：各个大流、迷你流本身、迷你 FAT、目录、FAT
	type blob struct {
		data  []byte
		start int
	}
	var blobs []*blob
	next := 0
	add := func(d []byte) *blob {
		b := &blob{d, next}
		next += secs(len(d))
		blobs = append(blobs, b)
		return b
	}
	big := make([]*blob, len(streams))
	for i, s := range streams {
		if len(s.data) >= 4096 {
			big[i] = add(s.data)
		}
	}
	var miniBlob, miniFATBlob *blob
	if len(mini) > 0 {
		miniBlob = add(mini)
		miniFATBlob = add(miniFATBytes)
	}
	dirBlob := add(make([]byte, (len(streams)+1)*128))
	fatStart := next
	fatSecs := 1
	for (next+fatSecs)*4 > fatSecs*ss {
		fatSecs++
	}
	total := next + fatSecs
	fat := make([]uint32, fatSecs*ss/4)
	for i := range fat {
		fat[i] = secFree
	}
	for _, b := range blobs {
		n := secs(len(b.data))
		for k := 0; k < n; k++ {
			if k == n-1 {
				fat[b.start+k] = secEnd
			} else {
				fat[b.start+k] = uint32(b.start + k + 1)
			}
		}
	}
	for k := 0; k < fatSecs; k++ {
		fat[fatStart+k] = 0xFFFFFFFD // FAT 扇区
	}
	out := make([]byte, (total+1)*ss)
	h := out[:ss]
	copy(h, cfbMagic)
	le.PutUint16(h[0x18:], 0x3E)
	le.PutUint16(h[0x1A:], 3)
	le.PutUint16(h[0x1C:], 0xFFFE)
	le.PutUint16(h[0x1E:], 9)
	le.PutUint16(h[0x20:], 6)
	le.PutUint32(h[0x2C:], uint32(fatSecs))
	le.PutUint32(h[0x30:], uint32(dirBlob.start))
	le.PutUint32(h[0x38:], 4096)
	le.PutUint32(h[0x3C:], secEnd)
	if miniFATBlob != nil {
		le.PutUint32(h[0x3C:], uint32(miniFATBlob.start))
		le.PutUint32(h[0x40:], uint32(secs(len(miniFATBytes))))
	}
	le.PutUint32(h[0x44:], secEnd)
	for i := 0; i < 109; i++ {
		v := uint32(secFree)
		if i < fatSecs {
			v = uint32(fatStart + i)
		}
		le.PutUint32(h[0x4C+i*4:], v)
	}
	// 目录：根 → 第一个流，其余流用 right 串起来
	dir := dirBlob.data
	entry := func(i int, name string, typ byte, start, size uint32, right, child uint32) {
		e := dir[i*128 : (i+1)*128]
		u := utf16.Encode([]rune(name))
		for k, c := range u {
			le.PutUint16(e[k*2:], c)
		}
		le.PutUint16(e[0x40:], uint16(len(u)*2+2))
		e[0x42] = typ
		le.PutUint32(e[0x44:], secFree)
		le.PutUint32(e[0x48:], right)
		le.PutUint32(e[0x4C:], child)
		le.PutUint32(e[0x74:], start)
		le.PutUint32(e[0x78:], size)
	}
	rootStart, rootSize := uint32(secEnd), uint32(0)
	if miniBlob != nil {
		rootStart, rootSize = uint32(miniBlob.start), uint32(len(mini))
	}
	entry(0, "Root Entry", 5, rootStart, rootSize, secFree, 1)
	for i, s := range streams {
		right := uint32(secFree)
		if i+1 < len(streams) {
			right = uint32(i + 2)
		}
		start := uint32(miniStart[i])
		if big[i] != nil {
			start = uint32(big[i].start)
		}
		entry(i+1, s.name, 2, start, uint32(len(s.data)), right, secFree)
	}
	for _, b := range blobs {
		copy(out[(b.start+1)*ss:], b.data)
	}
	for k := 0; k < fatSecs; k++ {
		sec := out[(fatStart+k+1)*ss:]
		for j := 0; j < ss/4; j++ {
			le.PutUint32(sec[j*4:], fat[k*ss/4+j])
		}
	}
	return out
}

func utf16le(s string) []byte {
	var b []byte
	for _, u := range utf16.Encode([]rune(s)) {
		b = append(b, byte(u), byte(u>>8))
	}
	return b
}

// ---------- Word ----------

// buildDoc 正文由一段 UTF-16 和一段压缩（单字节）文字组成，后面跟脚注
func buildDoc(flags uint16, ident uint16) []byte {
	le := binary.LittleEndian
	main1 := "标题\r第一段\t正文\r名称\x07数量\x07\x07苹果\x07第一行\r第二行\x07\x07链接：\x13 HYPERLINK \"http://x\" \x14示例网站\x15。\r"
	main2 := "Plain ascii\x0bline\x0cpage\r"
	foot := "\x02 脚注内容\r"
	u1 := utf16.Encode([]rune(main1))
	u3 := utf16.Encode([]rune(foot))
	wd := make([]byte, 0x400)
	le.PutUint16(wd[0:], ident)
	le.PutUint16(wd[2:], 0xC1)
	le.PutUint16(wd[0x0A:], flags|0x0200)
	off1 := len(wd)
	wd = append(wd, utf16le(main1)...)
	off2 := len(wd)
	wd = append(wd, []byte(main2)...)
	off3 := len(wd)
	wd = append(wd, utf16le(foot)...)
	cpMain := len(u1) + len(main2)
	le.PutUint32(wd[0x4C:], uint32(cpMain))
	le.PutUint32(wd[0x50:], uint32(len(u3)))
	// 1Table：Clx = Pcdt（3 段）
	cps := []uint32{0, uint32(len(u1)), uint32(cpMain), uint32(cpMain + len(u3))}
	var plc []byte
	for _, c := range cps {
		plc = le.AppendUint32(plc, c)
	}
	for _, p := range []struct {
		fc         uint32
		compressed bool
	}{{uint32(off1), false}, {uint32(off2), true}, {uint32(off3), false}} {
		fc := p.fc
		if p.compressed {
			fc = fc*2 | 0x40000000
		}
		plc = append(plc, 0, 0)
		plc = le.AppendUint32(plc, fc)
		plc = append(plc, 0, 0)
	}
	clx := []byte{0x01, 2, 0, 0xAA, 0xBB, 0x02} // 一个 Prc 再接 Pcdt
	clx = le.AppendUint32(clx, uint32(len(plc)))
	clx = append(clx, plc...)
	tbl := append(make([]byte, 16), clx...)
	le.PutUint32(wd[0x1A2:], 16)
	le.PutUint32(wd[0x1A6:], uint32(len(clx)))
	return buildCFB([]cfbStream{{"WordDocument", wd}, {"1Table", tbl}})
}

func TestWord(t *testing.T) {
	doc, err := Read(buildDoc(0, 0xA5EC))
	if err != nil {
		t.Fatal(err)
	}
	wantBody := "标题\n第一段\t正文\n| 名称 | 数量 |\n| 苹果 | 第一行 第二行 |\n链接：示例网站。\nPlain ascii\nline\npage"
	if doc.Kind != "word" || doc.Word.Body != wantBody {
		t.Fatalf("正文：%q\n应为：%q", doc.Word.Body, wantBody)
	}
	if doc.Word.Footnotes != "脚注内容" {
		t.Fatalf("脚注：%q", doc.Word.Footnotes)
	}
	if _, err := Read(buildDoc(0x0100, 0xA5EC)); !errors.Is(err, ErrEncrypted) {
		t.Fatalf("加密文档应报 ErrEncrypted：%v", err)
	}
	if _, err := Read(buildDoc(0, 0xA5DC)); err == nil || !strings.Contains(err.Error(), "Word 6.0") {
		t.Fatalf("Word 6 应提示老格式：%v", err)
	}
}

// ---------- PowerPoint ----------

func pptRecord(ver, inst, typ uint16, body []byte) []byte {
	b := binary.LittleEndian.AppendUint16(nil, ver|inst<<4)
	b = binary.LittleEndian.AppendUint16(b, typ)
	b = binary.LittleEndian.AppendUint32(b, uint32(len(body)))
	return append(b, body...)
}

func buildPpt(token uint32) []byte {
	le := binary.LittleEndian
	chars := func(s string) []byte { return pptRecord(0, 0, rtTextCharsAtom, utf16le(s)) }
	persistAtom := func(ref uint32) []byte {
		return pptRecord(0, 0, rtSlidePersistAtom, le.AppendUint32(nil, ref))
	}
	var list []byte
	list = append(list, persistAtom(2)...)
	list = append(list, chars("第一页标题")...)
	list = append(list, chars("要点一\r要点二")...)
	list = append(list, persistAtom(3)...)
	list = append(list, pptRecord(0, 0, rtTextBytesAtom, []byte("Second slide"))...)
	docC := pptRecord(0xF, 0, rtDocument, pptRecord(0xF, 0, rtSlideListWithText, list))
	master := pptRecord(0xF, 0, rtMainMaster, chars("单击此处编辑母版标题样式"))
	slide1 := pptRecord(0xF, 0, rtSlide, pptRecord(0xF, 0, 0xF002, pptRecord(0xF, 0, 0xF00D, chars("文本框里的字"))))
	slide2 := pptRecord(0xF, 0, rtSlide, nil)

	var d []byte
	offDoc := len(d)
	d = append(d, docC...)
	d = append(d, master...)
	off1 := len(d)
	d = append(d, slide1...)
	off2 := len(d)
	d = append(d, slide2...)
	offDir := len(d)
	dirBody := le.AppendUint32(nil, 1|3<<20)
	for _, o := range []int{offDoc, off1, off2} {
		dirBody = le.AppendUint32(dirBody, uint32(o))
	}
	d = append(d, pptRecord(0, 0, rtPersistDirectory, dirBody)...)
	offEdit := len(d)
	ue := make([]byte, 28)
	le.PutUint32(ue[12:], uint32(offDir))
	le.PutUint32(ue[16:], 1)
	d = append(d, pptRecord(0, 0, rtUserEditAtom, ue)...)

	cu := make([]byte, 20)
	le.PutUint32(cu[0:], 0x14)
	le.PutUint32(cu[4:], token)
	le.PutUint32(cu[8:], uint32(offEdit))
	return buildCFB([]cfbStream{{"Current User", pptRecord(0, 0, 0x0FF6, cu)}, {"PowerPoint Document", d}})
}

func TestPowerPoint(t *testing.T) {
	b := buildPpt(0xE391C05F)
	// Current User 只有几十字节，应放在迷你流里；PowerPoint Document 不到 4 KB 也在迷你流里
	f, err := openCFB(b)
	if err != nil {
		t.Fatal(err)
	}
	if cu, ok := f.stream("Current User"); !ok || len(cu) != 28 || len(f.miniStream) == 0 {
		t.Fatalf("迷你流读取不对：%d %v", len(cu), ok)
	}
	doc, err := Read(b)
	if err != nil {
		t.Fatal(err)
	}
	got := fmt.Sprintf("%q", doc.Slides)
	want := fmt.Sprintf("%q", [][]string{{"第一页标题", "要点一\n要点二", "文本框里的字"}, {"Second slide"}})
	if got != want {
		t.Fatalf("得到 %s\n应为 %s", got, want)
	}
	if _, err := Read(buildPpt(0xF3D1C4DF)); !errors.Is(err, ErrEncrypted) {
		t.Fatalf("加密演示文稿应报 ErrEncrypted：%v", err)
	}
}

// ---------- Excel（testdata 由 xlwt 生成，见文件内容说明） ----------

func cells(s Sheet) map[string]string {
	m := map[string]string{}
	for _, r := range s.Rows {
		for c, v := range r.Cells {
			m[fmt.Sprintf("%c%d", 'A'+c, r.Num)] = v
		}
	}
	return m
}

func TestExcel(t *testing.T) {
	b, err := os.ReadFile("testdata/small.xls")
	if err != nil {
		t.Fatal(err)
	}
	doc, err := Read(b)
	if err != nil {
		t.Fatal(err)
	}
	if len(doc.Sheets) != 2 || doc.Sheets[0].Name != "销售表" || doc.Sheets[1].Name != "Sheet2" {
		t.Fatalf("工作表：%v", doc.Sheets)
	}
	m := cells(doc.Sheets[0])
	for k, want := range map[string]string{
		"A1": "名称", "E1": "是否到货", "A2": "苹果", "B2": "3", "C2": "4.5", "D2": "2026-11-23", "E2": "TRUE",
		"A3": "香蕉 banana", "C3": "0.3", "D3": "2024-02-29", "E3": "FALSE",
		"A5": "2026-01-02 13:45:30", "B5": "08:30:00", "C5": "2025-05-01", "G6": "-1234567",
	} {
		if m[k] != want {
			t.Errorf("%s = %q，应为 %q", k, m[k], want)
		}
	}
	if cells(doc.Sheets[1])["A1"] != "第二个工作表" {
		t.Errorf("第二个工作表：%v", cells(doc.Sheets[1]))
	}
}

func TestExcelSSTContinue(t *testing.T) {
	b, err := os.ReadFile("testdata/sst-continue.xls")
	if err != nil {
		t.Fatal(err)
	}
	// 确认共享字符串表确实被拆进了 CONTINUE 记录
	f, _ := openCFB(b)
	wb, _ := f.stream("Workbook")
	recs := xlsRecords(wb, 0)
	cont := 0
	for i, r := range recs {
		if r.typ == recSST {
			for j := i + 1; j < len(recs) && recs[j].typ == recContinue; j++ {
				cont++
			}
		}
	}
	if cont == 0 {
		t.Fatal("测试文件里没有 CONTINUE，测不到跨记录的字符串")
	}
	doc, err := Read(b)
	if err != nil {
		t.Fatal(err)
	}
	m := cells(doc.Sheets[0])
	for i := 0; i < 600; i++ {
		wantA := fmt.Sprintf("第%d行：%s", i, strings.Repeat("汉字", i%7+1))
		wantB := fmt.Sprintf("row-%d-%s", i, strings.Repeat("x", i%13))
		if m[fmt.Sprintf("A%d", i+1)] != wantA || m[fmt.Sprintf("B%d", i+1)] != wantB {
			t.Fatalf("第 %d 行：%q %q", i+1, m[fmt.Sprintf("A%d", i+1)], m[fmt.Sprintf("B%d", i+1)])
		}
	}
}

func TestNotCFB(t *testing.T) {
	if _, err := Read([]byte("hello")); err == nil {
		t.Fatal("应报错")
	}
	broken := append([]byte{}, cfbMagic...)
	broken = append(broken, bytes.Repeat([]byte{0xFF}, 600)...)
	if _, err := Read(broken); err == nil {
		t.Fatal("损坏的文件应报错")
	}
}

// ---------- 恶意放大的文件：必须很快结束，内存占用有上限 ----------

func measure(t *testing.T, name string, limitMB uint64, fn func()) {
	t.Helper()
	runtime.GC()
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	start := time.Now()
	fn()
	elapsed := time.Since(start)
	runtime.ReadMemStats(&after)
	allocMB := (after.TotalAlloc - before.TotalAlloc) >> 20
	t.Logf("%s：%v，累计分配 %d MB", name, elapsed.Round(time.Millisecond), allocMB)
	if elapsed > 5*time.Second || allocMB > limitMB {
		t.Fatalf("%s 太慢或分配太多：%v，%d MB", name, elapsed, allocMB)
	}
}

func TestWordAmplification(t *testing.T) {
	le := binary.LittleEndian
	wd := make([]byte, 0x400)
	le.PutUint16(wd[0:], 0xA5EC)
	le.PutUint16(wd[2:], 0xC1)
	le.PutUint16(wd[0x0A:], 0x0200)
	off := len(wd)
	wd = append(wd, utf16le(strings.Repeat("放大", 1000))...)
	const pieces = 20000
	var plc []byte
	for i := 0; i <= pieces; i++ {
		plc = le.AppendUint32(plc, uint32(i)<<25) // 每段声称有 3200 万字
	}
	for i := 0; i < pieces; i++ {
		plc = append(plc, 0, 0)
		plc = le.AppendUint32(plc, uint32(off)) // 全都指向同一块数据
		plc = append(plc, 0, 0)
	}
	clx := le.AppendUint32([]byte{0x02}, uint32(len(plc)))
	clx = append(clx, plc...)
	le.PutUint32(wd[0x1A2:], 0)
	le.PutUint32(wd[0x1A6:], uint32(len(clx)))
	b := buildCFB([]cfbStream{{"WordDocument", wd}, {"1Table", clx}})
	var doc *Document
	var err error
	measure(t, "Word", 400, func() { doc, err = Read(b) })
	if err != nil {
		t.Fatal(err)
	}
	if n := len([]rune(doc.Word.Body)); n == 0 || n > maxWordRunes {
		t.Fatalf("正文长度 %d", n)
	}
}

func TestExcelHugeSSTCount(t *testing.T) {
	le := binary.LittleEndian
	rec := func(typ uint16, d []byte) []byte {
		b := le.AppendUint16(nil, typ)
		b = le.AppendUint16(b, uint16(len(d)))
		return append(b, d...)
	}
	bof := le.AppendUint16(nil, 0x0600)
	bof = le.AppendUint16(bof, 0x0005)
	bof = append(bof, make([]byte, 12)...)
	sst := le.AppendUint32(nil, 5_000_000)
	sst = le.AppendUint32(sst, 5_000_000) // 声称有 500 万条
	sst = append(sst, 1, 0, 0, 'A')
	wb := append(rec(recBOF, bof), rec(recSST, sst)...)
	wb = append(wb, rec(recEOF, nil)...)
	b := buildCFB([]cfbStream{{"Workbook", wb}})
	measure(t, "Excel", 50, func() {
		if _, err := Read(b); err != nil {
			t.Fatal(err)
		}
	})
}

func TestPptAmplification(t *testing.T) {
	le := binary.LittleEndian
	big := pptRecord(0, 0, rtTextCharsAtom, utf16le(strings.Repeat("字", 50_000)))
	var list []byte
	for i := 0; i < 5000; i++ {
		list = append(list, pptRecord(0, 0, rtSlidePersistAtom, le.AppendUint32(nil, 2))...) // 全都指向同一张幻灯片
	}
	docC := pptRecord(0xF, 0, rtDocument, pptRecord(0xF, 0, rtSlideListWithText, list))
	slide := pptRecord(0xF, 0, rtSlide, big)
	var d []byte
	d = append(d, docC...)
	offSlide := len(d)
	d = append(d, slide...)
	offDir := len(d)
	dirBody := le.AppendUint32(nil, 1|2<<20)
	dirBody = le.AppendUint32(dirBody, 0)
	dirBody = le.AppendUint32(dirBody, uint32(offSlide))
	d = append(d, pptRecord(0, 0, rtPersistDirectory, dirBody)...)
	offEdit := len(d)
	ue := make([]byte, 28)
	le.PutUint32(ue[12:], uint32(offDir))
	le.PutUint32(ue[16:], 1)
	d = append(d, pptRecord(0, 0, rtUserEditAtom, ue)...)
	cu := make([]byte, 20)
	le.PutUint32(cu[0:], 0x14)
	le.PutUint32(cu[4:], 0xE391C05F)
	le.PutUint32(cu[8:], uint32(offEdit))
	b := buildCFB([]cfbStream{{"Current User", pptRecord(0, 0, 0x0FF6, cu)}, {"PowerPoint Document", d}})
	var doc *Document
	var err error
	measure(t, "PPT", 300, func() { doc, err = Read(b) })
	if err != nil {
		t.Fatal(err)
	}
	total := 0
	for _, s := range doc.Slides {
		for _, p := range s {
			total += len(p)
		}
	}
	if total > maxPptText+200_000 {
		t.Fatalf("收集了 %d 字节，超过上限", total)
	}
}
