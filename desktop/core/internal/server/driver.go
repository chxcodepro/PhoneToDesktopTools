package server

import (
	"encoding/json"
	"log"
	"net/http"
	"sync"
)

// DriverConfig 手机 USB 驱动（Windows）：Missing 返回缺驱动的设备列表（没有时为 nil），Install 提权安装。
type DriverConfig struct {
	Missing func() any
	Install func() error

	mu      sync.Mutex
	running bool
}

// handleDriverInstall POST /api/driver/install：弹出 UAC 安装驱动，装完返回 {ok, message}
func (s *Server) handleDriverInstall(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	res := map[string]any{"ok": false}
	switch d := s.Driver; {
	case d == nil:
		res["message"] = "这个系统不需要安装手机驱动"
	default:
		d.mu.Lock()
		busy := d.running
		d.running = true
		d.mu.Unlock()
		if busy {
			res["message"] = "正在安装驱动，请稍候"
			break
		}
		log.Printf("正在安装手机 USB 驱动…")
		err := d.Install()
		d.mu.Lock()
		d.running = false
		d.mu.Unlock()
		if err != nil {
			log.Printf("驱动安装失败：%v", err)
			res["message"] = err.Error()
		} else {
			log.Printf("手机 USB 驱动已安装")
			res["ok"] = true
		}
		s.changed()
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(res)
}
