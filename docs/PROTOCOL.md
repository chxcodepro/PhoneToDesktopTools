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

### 1.2 WiFi：局域网直连

WiFi 连接不走 adb，而是手机直接连电脑的局域网 IP（详见第 9 节）。Deep Link 里额外带 `pcid`（电脑标识），手机 USB 连上后调用 `p2d/pc.info` 记下电脑的局域网地址，没配对过就调用 `p2d/pair.issue` 自动配对。拔掉数据线（令牌失效 / 连接断开）时，手机自动改用 WiFi 直连同一台电脑；插回数据线时电脑重新下发 Deep Link，手机切回 USB（可在手机「设备」页关闭）。

（之前的「adb 网络调试 + 自动 adb connect」方案已移除：它会让手机在局域网开着 5555 端口，且只能由电脑去连手机。）

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
| `readonly` | 只读类：`sys_info`、`fs_list`、`fs_read`、`fs_search`、`doc_read`、`screen_capture`、`ui_tree` |
| `standard` | 只读类 + `fs_write`、`fs_edit`、`input_mouse`、`input_keyboard`、`ui_act` |
| `full` | 全部，包括 `shell_exec`、`fs_delete` |

四个开关再按类别收紧：`shell` → `shell_exec`；`fs` → `fs_*` 和 `doc_read`；`screen` → `screen_capture`、`ui_tree`；`input` → `input_*`、`ui_act`。

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
| `doc_read` | `path`，`sheet?`，`max_rows?`（默认 200），`pages?`（PDF 页码，如 `1-3,5`） | 读取 docx / xlsx / pptx / pdf，以及 Office 97-2003 的 doc / xls / ppt 和 WPS 的 wps / et / dps 的文字（旧格式按文件内容识别，纯 Go 实现：`internal/olddoc`，含复合文档、Word 分段表、Excel BIFF8 共享字符串与日期格式、PPT 持久化目录；加密文件和 Word 6 / Excel 5 等更老的格式返回说明；扩展名是 .doc 但实际是 RTF / 网页的文件提示改用 `fs_read`）；Excel 按工作表输出，制表符分隔；PDF 按页输出，单次约 200 KB，超出时提示用 `pages` 继续。PDF 解析为纯 Go 实现（`internal/pdftext`）：支持压缩对象流、交叉引用流、损坏文件重建、只设权限密码的加密文件（RC4 / AES-128 / AES-256），中文靠 ToUnicode 或 GBK / UCS2 等预定义编码；扫描件、设了打开密码的文件返回说明 |
| `fs_delete` | `path` | 移到回收站（Windows 回收站；Linux 放到 `~/.local/share/Trash`） |
| `screen_capture` | `display?`（默认 0），`max_width?`（默认 1280），`quality?`（默认 70） | 返回 JPEG 图片，外加一段文字说明缩放比例：`屏幕坐标 = 截图坐标 ÷ scale + 显示器偏移` |
| `input_mouse` | `action`：`move` / `click` / `double_click` / `right_click` / `middle_click` / `down` / `up` / `scroll` / `drag`；`x`、`y`；`to_x`、`to_y`（drag 用）；`dy`（scroll 用，正数向上） | 坐标为屏幕坐标（虚拟桌面像素） |
| `input_keyboard` | `action`：`type`（输入 `text`，支持中文）或 `key`（按组合键 `keys`，如 `ctrl+c`、`alt+f4`、`enter`） | |
| `ui_tree` | `window?`（标题包含即可；不填为前台窗口；`任务栏`），`name?`，`type?`，`list_windows?`，`max?`（默认 150） | 读取界面元素（控件树）：每行 `[类型] 名称 (x, y)`，坐标为元素中心的屏幕坐标；输入框附带当前值。窗口最小化时，只有同时满足 `ui_act` 的权限（`standard` 以上且开着 `input`）才会先还原，否则不动窗口、只返回提示。Windows 直接调用系统 UI Automation（COM，Win7 起都有）；Linux 暂不支持 |
| `ui_act` | `name`，`action`：`click` / `set_value` / `focus` / `toggle` / `expand` / `collapse`；`window?`，`type?`，`index?`，`value?` | 按名称操作元素，不依赖坐标；同名时优先选支持该动作的元素。不支持的元素返回坐标，改用 `input_mouse` |

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

- `GET /api/status`：电脑信息、adb 是否可用（不可用时 `adbError` 说明原因）、设备列表（序列号、型号、阶段）、当前会话；Windows 上有已插上但缺 USB 驱动的手机时带 `driverMissing: [{name, instanceId}]`
- `POST /api/disconnect`：断开所有手机。设备在拔线前不会自动重连
- `POST /api/driver/install`（Windows）：以管理员身份（弹出 UAC）安装电脑端自带的 ADB 接口驱动（WinUSB，按兼容标识 `USB\Class_FF&SubClass_42&Prot_01` 匹配所有品牌手机），等安装结束返回 `{ok, message?}`。已装厂商驱动的手机不受影响

## 8. 扩展（MCP / Skill，自定义扩展）

扩展的配置都保存在手机上（令牌类请求头 / 环境变量存手机安全存储），Agent 看到的工具 = 电脑工具 + 手机工具 + 扩展工具。电脑未连接时仍可使用手机工具和远程 MCP。

### 8.1 远程 MCP（手机直连）

手机用自己的网络直接连接，不经过电脑。支持 Streamable HTTP（默认）和旧版 SSE（地址以 `/sse` 结尾，或配置里 `"type": "sse"`）。工具合并到 Agent 时改名为 `<前缀>__<工具名>`（前缀由服务名生成，最多 64 字符），描述前加 `[MCP · 服务名]`。

### 8.2 电脑上的 stdio MCP（电脑端转发）

需要「执行命令」权限。进程按「手机序列号 / 扩展 ID」管理，手机断线重连（如切到 WiFi）后继续使用，手机断开或电脑端退出时结束。

| 方法 | 参数 | 结果 |
|---|---|---|
| `p2d/mcp.start` | `id`，`command`，`args?`，`env?`，`cwd?` | `{name, tools}`；配置不变且进程还在时直接返回 |
| `p2d/mcp.call` | `id`，`name`，`arguments?` | MCP `tools/call` 的结果原样返回；进程不在时报错含 `not_started`，手机端会重新 start 后重试 |
| `p2d/mcp.stop` | `id` | `{}` |

### 8.3 Skill

文件存在手机上；`skill_run` 时按内容哈希同步到电脑缓存目录（`<用户缓存目录>/PhoneToDesktop/skills/<名称>-<哈希>/`，可用环境变量 `P2D_SKILL_DIR` 覆盖），再用 `shell_exec` 执行（受「执行命令」权限控制）。

| 方法 | 参数 | 结果 |
|---|---|---|
| `p2d/skill.has` | `name`，`hash` | `{dir, exists}` |
| `p2d/skill.sync` | `name`，`hash`，`files: [{path, data(base64)}]` | `{dir}`；需要「文件」写权限，路径不能跳出目录，单个 Skill 最多 32 MB |

### 8.4 扩展相关的 Agent 工具（手机端）

| 工具 | 说明 |
|---|---|
| `skill_read` | 读 Skill 的 SKILL.md 或附带文件（系统提示词里只放名称和描述） |
| `skill_run` | 在电脑上执行 Skill 附带的脚本，按扩展名选解释器（.ps1 / .bat / .py / .js / .sh） |
| `ext_list` / `ext_toggle` | 查看、启用 / 停用扩展 |
| `ext_add_mcp` / `ext_install_skill` / `ext_create_skill` / `ext_remove` | 安装、新建、卸载；先在对话里弹出确认卡片，用户确认后才生效 |

## 9. 局域网直连（WiFi）

电脑端在 `0.0.0.0:39272`（`-lan-port`，0 表示关闭）提供局域网入口，只有三个路径：`/p2d/ping`（探测，返回 `{app:"p2d", pc, name}`）、`/p2d/pair`（配对）、`/p2d/secure`（加密会话）。状态接口等仍只接受本机访问。电脑身份和配对过的手机保存在用户配置目录 `PhoneToDesktop/lan.json`（仅当前用户可读）。

电脑标识 `pc`（pcId）第一次启动时生成并存进 `lan.json`，之后不再改变。新建时由本机系统标识（Windows `MachineGuid` / Linux `machine-id`）加主机名派生，`lan.json` 丢失或换了位置（例如从 MSIX 打包的程序里启动，写 `%APPDATA%` 会被重定向）也会得到同一个 pcId；取不到系统标识时随机生成。`p2d/pc.info`、配对成功的 `ok` 和加密会话的 `hello` 里另带机器指纹 `mid`（同样派生，盐不同；取不到时不带）。手机端设备记录以 pcId 为主键，收到 `mid` 时把同一台电脑的旧记录（`mid` 相同；或旧记录没有 `mid` 且电脑名、系统都相同）合并掉，旧 pcId 下的对话归到新 pcId。旧版手机端忽略 `mid`。

### 9.1 配对（每台手机和电脑共享一个 32 字节密钥 K）

| 方式 | 过程 |
|---|---|
| 插数据线（自动） | USB 会话里调用 `p2d/pair.issue {phone, name}`，电脑生成随机 K 返回（只允许 adb 隧道上的会话调用）。 |
| 扫码 | 电脑端点「配对新手机」后显示二维码 `p2d://pair?h=IP1,IP2&p=39272&id=电脑标识&n=电脑名&s=一次性密钥P`（16 字节，3 分钟内有效）。 |
| 输入 IP + 配对码 | 手机输入电脑 IP 后，电脑窗口显示 6 位配对码，用户在手机上输入核对。 |

扫码 / 配对码走 `/p2d/pair`（WebSocket，明文 JSON）：

1. 手机 → `{type:"pair", mode:"qr"|"code", phone, name, pub}`（X25519 公钥）；电脑端没打开配对窗口时返回 `{type:"error", code:"not_open"}`，同时只接受一台手机（`busy`）。
2. 电脑 → `{type:"pair", pc, name, os, pub}`。双方算出 `shared = X25519(...)`、`T = SHA256(长度前缀拼接("p2d pair v1", pub手机, pub电脑, 手机ID, 电脑ID))`。
3. 扫码：手机发 `{type:"confirm", mac: HMAC(P, "c"‖T)}`，`K = HKDF(shared, salt=P, info="p2d key"‖T)`。
   配对码：双方显示 / 计算 `SAS = HKDF(shared, salt=T, info="p2d sas", 4 字节) mod 10⁶`，电脑窗口显示 SAS，用户在手机上输入，手机核对一致后发 `{type:"confirm", mac: HMAC(Kc, "c")}`，`Kc = HKDF(shared, T, "p2d confirm")`，`K = HKDF(shared, T, "p2d key")`。有人在中间转发时两边算出的码不同，用户会发现。
4. 电脑核对后保存 K，返回 `{type:"ok", mac: HMAC(P或Kc, "s"‖…), pc, name, os, addrs, port}`，手机核对电脑的 mac。

### 9.2 加密会话 `/p2d/secure`

1. 手机 → `{type:"hello", phone, nc(16 字节随机), manual}`；未配对返回 `{type:"error", code:"unpaired"}`；电脑端点过「断开」时只接受 `manual:true`（用户手动点连接），否则返回 `suppressed`。
2. 电脑 → `{type:"hello", pc, name, os, ns(16 字节随机)}`。
3. `c2s ‖ s2c = HKDF(K, salt=nc‖ns, info="p2d secure v1", 64)`。之后每条消息都是二进制帧：`ChaCha20-Poly1305(密钥, nonce = 4 字节 0 + 8 字节大端计数器, 明文 = 帧类型(1 文本 / 2 二进制) ‖ 内容)`，两个方向各自从 0 计数。解密失败（密钥不对、篡改、重放）直接断开。
4. 解开后的内容就是普通的 MCP JSON-RPC，和 USB 的 `/mcp` 完全一样。会话的 `serial` 为 `lan:<手机ID>`，`route` 为 `wifi`。

手机在握手 `initialize` 的 `clientInfo` 里带 `deviceId`（手机标识）和 `device`（手机名），电脑上运行的 MCP 进程按手机标识归属，USB / WiFi 切换后继续使用。

测试向量见 `desktop/core/internal/lan/crypto_test.go` 和 `mobile/tests/secure.test.ts`（两端必须一致）。
