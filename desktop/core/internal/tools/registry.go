// Package tools 实现提供给手机端 Agent 的电脑工具（MCP tools）。
package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"p2d/core/internal/perm"
)

// Content 是 MCP tools/call 结果中的一项内容。
type Content struct {
	Type     string `json:"type"`
	Text     string `json:"text,omitempty"`
	Data     string `json:"data,omitempty"`
	MimeType string `json:"mimeType,omitempty"`
}

// Result 是 MCP tools/call 的结果。
type Result struct {
	Content []Content `json:"content"`
	IsError bool      `json:"isError,omitempty"`
}

// Handler 执行工具。返回 error 时会转换为 isError 结果。
type Handler func(ctx context.Context, args json.RawMessage) (*Result, error)

// Tool 描述一个工具。
type Tool struct {
	Name        string
	Description string
	InputSchema map[string]any
	Category    perm.Category
	Kind        perm.Kind
	Handler     Handler
}

// Info 是 tools/list 中返回的工具描述。
type Info struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	InputSchema map[string]any `json:"inputSchema"`
}

// Registry 工具注册表，保持注册顺序。
type Registry struct {
	list  []*Tool
	byKey map[string]*Tool
}

// NewRegistry 创建包含全部内置工具的注册表。
func NewRegistry() *Registry {
	r := &Registry{byKey: map[string]*Tool{}}
	registerSys(r)
	registerShell(r)
	registerFS(r)
	registerScreen(r)
	registerInput(r)
	return r
}

// Add 注册工具。
func (r *Registry) Add(t *Tool) {
	if _, dup := r.byKey[t.Name]; dup {
		panic("工具重复注册：" + t.Name)
	}
	r.list = append(r.list, t)
	r.byKey[t.Name] = t
}

// List 返回工具描述列表。
func (r *Registry) List() []Info {
	out := make([]Info, 0, len(r.list))
	for _, t := range r.list {
		out = append(out, Info{Name: t.Name, Description: t.Description, InputSchema: t.InputSchema})
	}
	return out
}

// Call 按权限检查后执行工具。工具不存在时返回 ok=false。
func (r *Registry) Call(ctx context.Context, p perm.Permissions, name string, args json.RawMessage) (res *Result, ok bool) {
	t, found := r.byKey[name]
	if !found {
		return nil, false
	}
	if allowed, why := p.Allow(t.Category, t.Kind); !allowed {
		return ErrorResult("没有权限调用 " + name + "：" + why), true
	}
	if len(args) == 0 || string(args) == "null" {
		args = json.RawMessage("{}")
	}
	defer func() {
		if e := recover(); e != nil {
			res = ErrorResult(fmt.Sprintf("工具 %s 内部错误：%v", name, e))
		}
	}()
	res, err := t.Handler(ctx, args)
	if err != nil {
		return ErrorResult(err.Error()), true
	}
	if res == nil {
		res = TextResult("完成")
	}
	return res, true
}

// TextResult 构造纯文字结果。
func TextResult(s string) *Result {
	return &Result{Content: []Content{{Type: "text", Text: s}}}
}

// ErrorResult 构造错误结果。
func ErrorResult(s string) *Result {
	return &Result{Content: []Content{{Type: "text", Text: s}}, IsError: true}
}

// decode 把参数解析到结构体，错误信息对 Agent 友好。
func decode(args json.RawMessage, v any) error {
	if err := json.Unmarshal(args, v); err != nil {
		return fmt.Errorf("参数格式错误：%v", err)
	}
	return nil
}

// ---------- JSON Schema 辅助 ----------

type prop map[string]any

func str(desc string) prop  { return prop{"type": "string", "description": desc} }
func num(desc string) prop  { return prop{"type": "number", "description": desc} }
func intg(desc string) prop { return prop{"type": "integer", "description": desc} }
func boolean(desc string) prop {
	return prop{"type": "boolean", "description": desc}
}
func enum(desc string, values ...string) prop {
	return prop{"type": "string", "description": desc, "enum": values}
}

func object(props map[string]prop, required ...string) map[string]any {
	p := map[string]any{}
	for k, v := range props {
		p[k] = map[string]any(v)
	}
	s := map[string]any{"type": "object", "properties": p}
	if len(required) > 0 {
		s["required"] = required
	}
	return s
}

// truncateMiddle 超长文字保留头尾。
func truncateMiddle(s string, max int) string {
	if len(s) <= max {
		return s
	}
	head := max * 6 / 10
	tail := max - head
	// 避免切断 UTF-8 字符
	for head > 0 && !isRuneStart(s[head]) {
		head--
	}
	start := len(s) - tail
	for start < len(s) && !isRuneStart(s[start]) {
		start++
	}
	return s[:head] + fmt.Sprintf("\n…（中间省略 %d 字节）…\n", start-head) + s[start:]
}

func isRuneStart(b byte) bool { return b&0xC0 != 0x80 }

func joinLines(lines []string) string { return strings.Join(lines, "\n") }
