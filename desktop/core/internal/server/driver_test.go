package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"p2d/core/internal/tools"
)

func TestDriverStatusAndInstall(t *testing.T) {
	srv := New(tools.NewRegistry(), NewTokenStore(""))
	missing := []string{"ADB Interface"}
	calls := 0
	var installErr error
	srv.Driver = &DriverConfig{
		Missing: func() any {
			if len(missing) == 0 {
				return nil
			}
			return missing
		},
		Install: func() error { calls++; return installErr },
	}
	h := srv.Handler()
	get := func(method, path string) map[string]any {
		t.Helper()
		req := httptest.NewRequest(method, path, nil)
		req.RemoteAddr = "127.0.0.1:1234"
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		var m map[string]any
		if err := json.Unmarshal(rec.Body.Bytes(), &m); err != nil {
			t.Fatalf("%s %s：%d %s", method, path, rec.Code, rec.Body.String())
		}
		return m
	}
	if st := get(http.MethodGet, "/api/status"); st["driverMissing"] == nil {
		t.Fatalf("状态里应有缺驱动的设备：%v", st)
	}
	installErr = errors.New("没有获得管理员权限")
	if r := get(http.MethodPost, "/api/driver/install"); r["ok"] != false || r["message"] != "没有获得管理员权限" {
		t.Fatalf("失败结果不对：%v", r)
	}
	installErr, missing = nil, nil
	if r := get(http.MethodPost, "/api/driver/install"); r["ok"] != true {
		t.Fatalf("成功结果不对：%v", r)
	}
	if st := get(http.MethodGet, "/api/status"); st["driverMissing"] != nil {
		t.Fatalf("装好后不应再提示：%v", st)
	}
	if calls != 2 {
		t.Fatalf("应安装 2 次，实际 %d", calls)
	}
	req := httptest.NewRequest(http.MethodGet, "/api/driver/install", nil)
	req.RemoteAddr = "127.0.0.1:1234"
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET 应被拒绝：%d", rec.Code)
	}
}
