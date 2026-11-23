package server

import (
	"encoding/json"
	"log"
	"net/http"
	"sync"
)

// ElevatedAction 需要管理员权限、由用户在电脑端界面上点按钮触发的修复操作：
// Windows 安装手机 USB 驱动，银河麒麟放行防火墙。
// Pending 返回需要处理的内容（写进 /api/status，nil 表示不需要），Run 弹出系统的提权窗口并执行。
type ElevatedAction struct {
	Name    string // 写进日志，如「安装手机 USB 驱动」
	Pending func() any
	Run     func() error

	mu      sync.Mutex
	running bool
}

// pending 不支持（nil）时也返回 nil
func (a *ElevatedAction) pending() any {
	if a == nil {
		return nil
	}
	return a.Pending()
}

// handleElevated POST：执行操作，完成后返回 {ok, message}
func (s *Server) handleElevated(get func() *ElevatedAction, notNeeded string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		res := map[string]any{"ok": false}
		switch a := get(); {
		case a == nil:
			res["message"] = notNeeded
		default:
			a.mu.Lock()
			busy := a.running
			a.running = true
			a.mu.Unlock()
			if busy {
				res["message"] = "正在" + a.Name + "，请稍候"
				break
			}
			log.Printf("正在%s…", a.Name)
			err := a.Run()
			a.mu.Lock()
			a.running = false
			a.mu.Unlock()
			if err != nil {
				log.Printf("%s失败：%v", a.Name, err)
				res["message"] = err.Error()
			} else {
				log.Printf("%s完成", a.Name)
				res["ok"] = true
			}
			s.changed()
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_ = json.NewEncoder(w).Encode(res)
	}
}
