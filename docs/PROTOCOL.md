# 手机 ↔ 电脑 通信协议（v1）

手机端（MCP 客户端）通过 USB 隧道连接电脑端 Core（MCP 服务端）。本文是两端实现的唯一依据。

## 1. 连接

| 项 | 值 |
|---|---|
| 地址 | `ws://127.0.0.1:39271/mcp?token=<令牌>` |
| 传输 | WebSocket 文本帧，每帧一条 JSON-RPC 2.0 消息 |
| Android 隧道 | 电脑执行 `adb reverse tcp:39271 tcp:39271`，手机访问自己的 127.0.0.1 即到达电脑 |
| 令牌错误 | HTTP 401，握手失败，手机端提示「请重新插拔数据线」 |

### 1.1 自动连接流程（Android）

电脑端 Core 检测到已授权的设备后，按顺序全自动执行：

1. `adb -s <序列号> shell pm path com.p2d.mobile`：没有安装就执行 `adb install -r <内置 APK>`
2. `adb -s <序列号> reverse tcp:39271 tcp:39271`
3. 生成随机令牌（32 位十六进制），通过 Deep Link 启动 App：

```
adb -s <序列号> shell am start -a android.intent.action.VIEW \
  -d 'p2d://connect?token=<令牌>&host=<电脑名>&os=<windows|linux>&port=39271' com.p2d.mobile
```

指定了包名，这个 Intent 只会投递给本 App。手机端收到 Deep Link 后立即连接。令牌在拔线后作废，下次插线重新生成。

开发调试时，Core 可以用 `--dev-token <值>` 指定一个固定令牌。

## 2. MCP 消息

采用 MCP 标准方法（协议版本 `2025-06-18`）：

| 方向 | 方法 | 说明 |
|---|---|---|
| 手机 → 电脑 | `initialize` | 握手，返回 `serverInfo`、`capabilities.tools` |
| 手机 → 电脑 | `notifications/initialized` | 通知，无响应 |
| 双向 | `ping` | 心跳，手机端每 10 秒发一次，连续 3 次无响应即判定断线并重连 |
| 手机 → 电脑 | `tools/list` | 返回工具清单（名称、描述、`inputSchema`） |
| 手机 → 电脑 | `tools/call` | `{ name, arguments }` → `{ content: [...], isError? }` |
| 手机 → 电脑 | `p2d/setPermissions` | 自定义扩展，见第 3 节 |

`tools/call` 的结果中，`content` 元素有两种：

- `{ "type": "text", "text": "..." }`
- `{ "type": "image", "data": "<base64>", "mimeType": "image/jpeg" }`

工具执行失败时返回 `isError: true` 和文字说明，不返回 JSON-RPC 错误。JSON-RPC 错误只用于协议层问题（方法不存在、参数格式错误、未初始化）。

> 工具名只用字母、数字和下划线（如 `fs_read`），以兼容 OpenAI / DeepSeek 的函数名规则 `^[a-zA-Z0-9_-]{1,64}$`。

## 3. 权限（由手机端设置）

```json
{ "jsonrpc": "2.0", "id": 3, "method": "p2d/setPermissions",
  "params": { "level": "full", "shell": true, "fs": true, "screen": true, "input": true } }
```

| level | 允许的工具 |
|---|---|
| `readonly` | 只读类：`sys_info`、`fs_list`、`fs_read`、`fs_search`、`screen_capture` |
| `standard` | 只读类 + `fs_write`、`fs_edit`、`input_mouse`、`input_keyboard` |
| `full` | 全部，包括 `shell_exec`、`fs_delete` |

四个开关再按类别收紧：`shell` → `shell_exec`；`fs` → `fs_*`；`screen` → `screen_capture`；`input` → `input_*`。

连接建立后、收到 `p2d/setPermissions` 之前，默认 `readonly`。手机端应在 `initialize` 之后立即发送一次，用户修改设置时再次发送。

## 4. 电脑端工具（v1）

| 工具 | 参数 | 说明 |
|---|---|---|
| `sys_info` | — | 主机名、系统、架构、用户、主目录、显示器列表 |
| `shell_exec` | `command`，`cwd?`，`timeout_sec?`（默认 60，最大 600） | Windows 用 `cmd /C`，Linux 用 `bash -c`（没有 bash 时用 `sh -c`）。GBK 输出自动转为 UTF-8，输出超过 100 KB 时截断 |
| `fs_list` | `path`（Windows 下传空字符串列出盘符），`show_hidden?` | 列出目录 |
| `fs_read` | `path`，`offset?`（起始行，从 1 开始），`limit?`（默认 500 行） | 自动识别 UTF-8 / GBK；拒绝读取二进制文件 |
| `fs_write` | `path`，`content`，`encoding?`（`utf-8` / `gbk`） | 自动创建上级目录 |
| `fs_edit` | `path`，`old_string`，`new_string`，`replace_all?` | `old_string` 必须唯一匹配（除非 `replace_all`）；保留原文件的编码和换行符 |
| `fs_search` | `path`，`name?`（通配符），`content?`（包含的文字），`max_results?`（默认 100） | 搜索文件名和文件内容 |
| `fs_delete` | `path` | 移到回收站（Windows 回收站；Linux 放到 `~/.local/share/Trash`） |
| `screen_capture` | `display?`（默认 0），`max_width?`（默认 1280），`quality?`（默认 70） | 返回 JPEG 图片，外加一段文字说明缩放比例：`屏幕坐标 = 截图坐标 ÷ scale + 显示器偏移` |
| `input_mouse` | `action`：`move` / `click` / `double_click` / `right_click` / `middle_click` / `down` / `up` / `scroll` / `drag`；`x`、`y`；`to_x`、`to_y`（drag 用）；`dy`（scroll 用，正数向上） | 坐标为屏幕坐标（虚拟桌面像素） |
| `input_keyboard` | `action`：`type`（输入 `text`，支持中文）或 `key`（按组合键 `keys`，如 `ctrl+c`、`alt+f4`、`enter`） | |

## 5. 状态接口（供电脑端 GUI 使用）

Core 在同一端口提供 HTTP 接口，只接受本机访问：

- `GET /api/status`：电脑信息、adb 是否可用、设备列表（序列号、型号、阶段）、当前会话
- `POST /api/disconnect`：断开所有手机。设备在拔线前不会自动重连
