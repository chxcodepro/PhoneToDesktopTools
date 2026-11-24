package server

// 工具调用日志：除了工具名和成败，再记下关键参数和失败原因，出问题时看日志就能还原 Agent 每一步做了什么。
// 可能含隐私的内容（键盘输入、写入文件的内容、填写的值等）只记长度，不记原文。

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"unicode/utf8"

	"p2d/core/internal/tools"
)

// secretArgs 只记长度的参数
var secretArgs = map[string]bool{
	"text": true, "content": true, "data": true, "value": true,
	"old_string": true, "new_string": true, "password": true, "token": true, "secret": true,
}

// resultTools 成功时也记下结果的工具（结果短、对排查有用）
var resultTools = map[string]bool{"window_activate": true, "ui_act": true}

// argsSummary 参数摘要，如 name="微信" action=click
func argsSummary(raw json.RawMessage) string {
	var m map[string]any
	if len(raw) == 0 || json.Unmarshal(raw, &m) != nil || len(m) == 0 {
		return ""
	}
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		var v string
		switch x := m[k].(type) {
		case string:
			if secretArgs[strings.ToLower(k)] {
				v = fmt.Sprintf("（%d 字）", utf8.RuneCountInString(x))
			} else {
				v = fmt.Sprintf("%q", clip(x, 120))
			}
		case nil:
			continue
		case bool, float64:
			v = fmt.Sprint(x)
		default:
			if secretArgs[strings.ToLower(k)] {
				v = "（略）"
			} else {
				b, _ := json.Marshal(x)
				v = clip(string(b), 80)
			}
		}
		parts = append(parts, k+"="+v)
	}
	return clip(strings.Join(parts, " "), 300)
}

// resultSummary 结果里第一段文字的开头
func resultSummary(res *tools.Result) string {
	for _, c := range res.Content {
		if c.Type == "text" && strings.TrimSpace(c.Text) != "" {
			return clip(c.Text, 200)
		}
	}
	return ""
}

// callLine 一次调用的日志内容（不含会话前缀）
func callLine(name string, raw json.RawMessage, res *tools.Result, ms float64) string {
	status := "成功"
	if res.IsError {
		status = "失败"
	}
	line := fmt.Sprintf("调用 %s %s（%.0f ms）", name, status, ms)
	if a := argsSummary(raw); a != "" {
		line += " " + a
	}
	if res.IsError || resultTools[name] {
		if r := resultSummary(res); r != "" {
			line += " → " + r
		}
	}
	return line
}

// clip 截到 n 个字，换行换成空格
func clip(s string, n int) string {
	s = strings.Join(strings.Fields(s), " ")
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	r := []rune(s)
	return string(r[:n]) + "…"
}
