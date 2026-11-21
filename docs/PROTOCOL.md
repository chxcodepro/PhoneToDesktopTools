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

指定了包名，这个 Intent 只会投递给本 App。手机端收到 Deep Link 后立即连接。令牌按手机（`ro.serialno`）而不是按 adb 通道管理，手机的所有通道都断开后才作废，下次连接重新生成。

### 1.2 WiFi 局域网连接（Android）

不需要手机端改动，仍是上面的 adb 隧道，只是 adb 走网络（Core 默认开启，`-wifi=false` 关闭）：

1. 插着数据线时，Core 读取手机 WiFi 网卡（`wlan*`）的 IPv4 地址并记下（保存在用户配置目录 `PhoneToDesktop/wifi-peers.json`）；手机 adb 还不是网络模式时执行 `adb -s <序列号> tcpip 5555`（手机 adb 会重启一次，Core 等它回来后再继续）。
2. 拔掉数据线后，Core 立即 `adb connect <ip>:5555`，连上后在 WiFi 通道上重新 `reverse`。期间（最多 25 秒）令牌保留，手机端用原令牌自动重连，不重新拉起 App；40 秒内没重连上才用 Deep Link 拉起。
3. 数据线插回来时 USB 优先：在 USB 通道上 `reverse`（隧道改绑过来），再断开 WiFi 通道。
4. 手机不在线时，Core 每 15 秒尝试连一次记住的地址；连上的设备 `ro.serialno` 与记录不符就断开并删掉记录。用户点「断开」后，插线前不再自动连 WiFi。

限制：手机重启后 adb 网络模式失效，需要再插一次数据线；adb 网络连接同样需要手机已授权本机的 adb 密钥；Core 仍只监听 127.0.0.1。

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
| `readonly` | 只读类：`sys_info`、`fs_list`、`fs_read`、`fs_search`、`doc_read`、`screen_capture` |
| `standard` | 只读类 + `fs_write`、`fs_edit`、`input_mouse`、`input_keyboard` |
| `full` | 全部，包括 `shell_exec`、`fs_delete` |

四个开关再按类别收紧：`shell` → `shell_exec`；`fs` → `fs_*` 和 `doc_read`；`screen` → `screen_capture`；`input` → `input_*`。

连接建立后、收到 `p2d/setPermissions` 之前，默认 `readonly`。手机端应在 `initialize` 之后立即发送一次，用户修改设置时再次发送。

## 4. 电脑端工具（v1）

| 工具 | 参数 | 说明 |
|---|---|---|
| `sys_info` | — | 主机名、系统、架构、用户、是否管理员（`admin`）、主目录、显示器列表 |
| `shell_exec` | `command`，`cwd?`，`timeout_sec?`（默认 60，最大 600），`admin?` | Windows 用 `cmd /C`，Linux 用 `bash -c`（没有 bash 时用 `sh -c`）。GBK 输出自动转为 UTF-8，输出超过 100 KB 时截断。`admin: true` 时以管理员 / root 执行：Windows 弹出 UAC 授权框（命令写进临时批处理，输出重定向到文件后读回）；Linux 有免密 sudo 时用 `sudo -n`，否则用 `pkexec` 弹出密码框。已是管理员时直接执行 |
| `fs_list` | `path`（Windows 下传空字符串列出盘符），`show_hidden?` | 列出目录 |
| `fs_read` | `path`，`offset?`（起始行，从 1 开始），`limit?`（默认 500 行） | 自动识别 UTF-8 / GBK；拒绝读取二进制文件 |
| `fs_write` | `path`，`content`，`encoding?`（`utf-8` / `gbk`） | 自动创建上级目录 |
| `fs_edit` | `path`，`old_string`，`new_string`，`replace_all?` | `old_string` 必须唯一匹配（除非 `replace_all`）；保留原文件的编码和换行符 |
| `fs_search` | `path`，`name?`（通配符），`content?`（包含的文字），`max_results?`（默认 100） | 搜索文件名和文件内容 |
| `doc_read` | `path`，`sheet?`，`max_rows?`（默认 200） | 读取 docx / xlsx / pptx 的文字；Excel 按工作表输出，制表符分隔 |
| `fs_delete` | `path` | 移到回收站（Windows 回收站；Linux 放到 `~/.local/share/Trash`） |
| `screen_capture` | `display?`（默认 0），`max_width?`（默认 1280），`quality?`（默认 70） | 返回 JPEG 图片，外加一段文字说明缩放比例：`屏幕坐标 = 截图坐标 ÷ scale + 显示器偏移` |
| `input_mouse` | `action`：`move` / `click` / `double_click` / `right_click` / `middle_click` / `down` / `up` / `scroll` / `drag`；`x`、`y`；`to_x`、`to_y`（drag 用）；`dy`（scroll 用，正数向上） | 坐标为屏幕坐标（虚拟桌面像素） |
| `input_keyboard` | `action`：`type`（输入 `text`，支持中文）或 `key`（按组合键 `keys`，如 `ctrl+c`、`alt+f4`、`enter`） | |

## 5. 远程桌面推流（自定义扩展）

| 方向 | 方法 | 说明 |
|---|---|---|
| 手机 → 电脑 | `p2d/screen.start` | 参数 `{ display?, maxWidth?（默认 1280）, quality?（默认 60）, fps?（默认 10，最大 20） }`，返回 `{ displays }`。需要「查看屏幕」权限 |
| 手机 → 电脑 | `p2d/screen.stop` | 停止推流 |
| 电脑 → 手机 | `p2d/screen.frame`（通知） | `{ seq, data?, mimeType?, width, height, scale, x, y, cursorX?, cursorY?, display }` |
| 电脑 → 手机 | `p2d/screen.error`（通知） | `{ message }`，如锁屏时无法截图 |
| 电脑 → 手机 | `p2d/screen.stopped`（通知） | `{ reason }`，如权限被关闭 |

- **省带宽**：画面没有变化时只推送鼠标位置，不带 `data`，手机端继续显示上一帧；每 2 秒至少带一次完整画面。
- **坐标换算**：`屏幕坐标 = 图片坐标 ÷ scale + (x, y)`。
- **点击、输入**：远程桌面的点击和输入直接调用 `input_mouse`、`input_keyboard` 工具，受同样的权限控制。

## 6. 文件上传（自定义扩展）

用户在 Agent 对话里添加的文件（以及模型不支持图片时的图片），还有 Agent 用手机网络下载的驱动、安装包（`download_to_pc` 工具），由手机分块上传到电脑，保存在系统「下载」目录下的 `PhoneToDesktop` 文件夹（Windows：`%USERPROFILE%\Downloads\PhoneToDesktop`；Linux：`XDG_DOWNLOAD_DIR`，通常是 `~/下载/PhoneToDesktop`）。需要「读写文件」开关和「标准」以上权限。

| 方法 | 参数 | 返回 |
|---|---|---|
| `p2d/upload.begin` | `{ name, size }` | `{ id, path }`：创建文件，同名时自动改名为 `名称 (1).扩展名` |
| `p2d/upload.chunk` | `{ id, data }`（base64，建议每块 256 KB） | `{ written }`：按顺序追加 |
| `p2d/upload.end` | `{ id, verify? }` | `{ path, size, sha256, sha1, signature? }`：大小与 `begin` 声明的不一致时报错并删除文件。`verify: true` 时 Windows 上用 `Get-AuthenticodeSignature` 检查数字签名，`signature` 为 `状态|签名者`，如 `Valid|CN=Microsoft ...` |
| `p2d/upload.cancel` | `{ id }` | 删除未完成的文件 |

- 文件名会去掉路径和系统不允许的字符，最大 1 GB。
- 连接断开时，未完成的上传会被删除。
- 上传完成后，手机把保存路径告诉模型，Agent 再用 `fs_read`、`doc_read` 等工具处理。

### 手机端工具（不经过电脑）

和电脑工具合并后一起交给模型，走手机自己的网络，电脑完全断网时也能用：

| 工具 | 参数 | 说明 |
|---|---|---|
| `web_search` | `query`，`count?` | 必应搜索（先 `cn.bing.com`，失败再 `www.bing.com`，RSS 格式） |
| `web_fetch` | `url`，`max_chars?`，`all_links?` | 网页转文字（优先 `<main>` / `<article>`），并列出可下载文件链接 |
| `driver_search` | `query` | 微软更新目录（Microsoft Update Catalog）按硬件 ID / KB 编号搜索 |
| `download_to_pc` | `url` 或 `catalog_id`，`filename?`，`sha256?` | 手机下载到缓存后经 `p2d/upload.*` 传到电脑，返回路径、哈希、签名；`catalog_id` 自动取微软下载地址并核对其 SHA-1 |

## 7. 状态接口（供电脑端 GUI 使用）

Core 在同一端口提供 HTTP 接口，只接受本机访问：

- `GET /api/status`：电脑信息、adb 是否可用、设备列表（序列号、型号、阶段）、当前会话
- `POST /api/disconnect`：断开所有手机。设备在拔线前不会自动重连
