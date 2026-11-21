package adb

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestInstalledAPKPath(t *testing.T) {
	cases := map[string]string{
		"package:/data/app/~~a==/com.p2d.mobile-b==/base.apk":                                "/data/app/~~a==/com.p2d.mobile-b==/base.apk",
		"package:/data/app/x/split_config.arm64_v8a.apk\r\npackage:/data/app/x/base.apk\r\n": "/data/app/x/base.apk",
		"package:/data/app/x/only.apk":                                                       "/data/app/x/only.apk",
		"":                                                                                   "",
		"Error: unknown package":                                                             "",
	}
	for in, want := range cases {
		if got := installedAPKPath(in); got != want {
			t.Errorf("installedAPKPath(%q) = %q，期望 %q", in, got, want)
		}
	}
}

func TestAPKCacheRehashOnChange(t *testing.T) {
	p := filepath.Join(t.TempDir(), "p2d.apk")
	if err := os.WriteFile(p, []byte("v1"), 0o644); err != nil {
		t.Fatal(err)
	}
	var c apkCache
	h1, err := c.hash(p)
	if err != nil || len(h1) != 64 {
		t.Fatalf("hash = %q, %v", h1, err)
	}
	if err := os.WriteFile(p, []byte("v2 longer"), 0o644); err != nil {
		t.Fatal(err)
	}
	_ = os.Chtimes(p, time.Now().Add(time.Minute), time.Now().Add(time.Minute))
	h2, _ := c.hash(p)
	if h2 == h1 {
		t.Fatal("安装包变了，哈希应重新计算")
	}
}
