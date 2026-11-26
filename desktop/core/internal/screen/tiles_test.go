package screen

import (
	"bytes"
	"image"
	"image/color"
	"image/jpeg"
	"testing"
)

func testImage(w, h int) *image.RGBA {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.SetRGBA(x, y, color.RGBA{uint8(x), uint8(y), uint8(x ^ y), 255})
		}
	}
	return img
}

func TestTileEncoderFullThenDiff(t *testing.T) {
	img := testImage(600, 300) // 3×2 块，右边和下边是不满的块
	var e TileEncoder
	e.Quality = 70
	tiles, full, err := e.Encode(img)
	if err != nil || !full || len(tiles) != 6 {
		t.Fatalf("第一帧应整屏 6 块：full=%v n=%d err=%v", full, len(tiles), err)
	}
	seen := map[[2]int]bool{}
	for _, tl := range tiles {
		if seen[[2]int{tl.X, tl.Y}] {
			t.Fatalf("块位置重复：%d,%d", tl.X, tl.Y)
		}
		seen[[2]int{tl.X, tl.Y}] = true
		if tl.X == 512 && tl.W != 88 || tl.Y == 256 && tl.H != 44 {
			t.Fatalf("边上的块尺寸不对：%+v", tl)
		}
		cfg, err := jpeg.DecodeConfig(bytes.NewReader(tl.JPEG))
		if err != nil || cfg.Width != tl.W || cfg.Height != tl.H {
			t.Fatalf("块 JPEG 尺寸 %dx%d，期望 %dx%d（%v）", cfg.Width, cfg.Height, tl.W, tl.H, err)
		}
	}

	// 没变化：不发任何块
	tiles, full, _ = e.Encode(testImage(600, 300))
	if full || len(tiles) != 0 {
		t.Fatalf("画面没变应不发块：full=%v n=%d", full, len(tiles))
	}

	// 改一个像素：只发那一块
	img2 := testImage(600, 300)
	img2.SetRGBA(300, 280, color.RGBA{1, 2, 3, 255})
	tiles, _, _ = e.Encode(img2)
	if len(tiles) != 1 || tiles[0].X != 256 || tiles[0].Y != 256 {
		t.Fatalf("应只发 (256,256) 这一块：%+v", tiles)
	}

	// 尺寸变化：整屏重发
	tiles, full, _ = e.Encode(testImage(300, 300))
	if !full || len(tiles) != 4 {
		t.Fatalf("尺寸变化应整屏重发：full=%v n=%d", full, len(tiles))
	}

	// Reset 后整屏重发
	e.Reset()
	if _, full, _ = e.Encode(testImage(300, 300)); !full {
		t.Fatal("Reset 后应整屏重发")
	}
}

func TestTileEncoderSubImage(t *testing.T) {
	// 截图可能是带偏移的子图（多显示器），比较和编码都要按偏移取像素
	big := testImage(800, 400)
	sub := big.SubImage(image.Rect(100, 50, 700, 350)).(*image.RGBA)
	var e TileEncoder
	e.Quality = 70
	if _, _, err := e.Encode(sub); err != nil {
		t.Fatal(err)
	}
	big.SetRGBA(100, 50, color.RGBA{9, 9, 9, 255}) // 子图左上角
	tiles, _, _ := e.Encode(sub)
	if len(tiles) != 1 || tiles[0].X != 0 || tiles[0].Y != 0 {
		t.Fatalf("应只发左上角那块，实际 %d 块", len(tiles))
	}
}
