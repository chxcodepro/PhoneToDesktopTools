package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"p2d/core/internal/tools"
)

type fakeAccessory struct {
	connected  string
	suppressed bool
}

type fakeAccDevice struct {
	ID    string `json:"id"`
	Stage string `json:"stage"`
}

func (f *fakeAccessory) Devices() any    { return []fakeAccDevice{{ID: "A1", Stage: "available"}} }
func (f *fakeAccessory) Problem() string { return "" }
func (f *fakeAccessory) SuppressAll()    { f.suppressed = true }
func (f *fakeAccessory) Connect(id string) error {
	if id != "A1" {
		return errors.New("没有找到这台手机")
	}
	f.connected = id
	return nil
}

func TestAccessoryStatusAndConnect(t *testing.T) {
	srv := New(tools.NewRegistry(), NewTokenStore(""))
	acc := &fakeAccessory{}
	srv.Accessory = acc
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/api/status")
	if err != nil {
		t.Fatal(err)
	}
	var st struct {
		Devices []fakeAccDevice `json:"devices"`
		AOA     struct {
			Enabled bool `json:"enabled"`
		} `json:"aoa"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&st)
	resp.Body.Close()
	if !st.AOA.Enabled || len(st.Devices) != 1 || st.Devices[0].ID != "A1" {
		t.Fatalf("状态 %+v", st)
	}

	post := func(id string) map[string]any {
		resp, err := http.Post(ts.URL+"/api/aoa/connect?id="+id, "", nil)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var res map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&res)
		return res
	}
	if res := post("A1"); res["ok"] != true || acc.connected != "A1" {
		t.Fatalf("连接 %v", res)
	}
	if res := post("B2"); res["ok"] != false || res["message"] == "" {
		t.Fatalf("找不到的手机应报错：%v", res)
	}

	srv.DisconnectAll()
	if !acc.suppressed {
		t.Fatal("断开时应通知免调试连接")
	}
}
