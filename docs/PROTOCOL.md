# 手机 ↔ 电脑 通信协议（v1）

手机端（MCP 客户端）通过 USB 隧道连接电脑端 Core（MCP 服务端）。本文是两端实现的唯一依据。

## 1. 连接

| 项 | 值 |
|---|---|
| 地址 | `ws://127.0.0.1:39271/mcp?token=<令牌>` |
| 传输 | WebSocket 文本帧，每帧一条 JSON-RPC 2.0 消息 |
| Android 隧道 | 电脑经 ADB 建立反向转发（相当于 `adb reverse tcp:39271 tcp:39271`），手机访问自己的 127.0.0.1 即到达电脑 |
| 令牌错误 | HTTP 401，握手失败，手机端提示「请重新插拔数据线」 |

### 1.1 自动连接流程（Android）

电脑端 Core 不用 adb 程序，自己经 USB 和手机的 adbd 通信（`desktop/core/internal/adbwire`，协议同 AOSP 的 `protocol.txt`）：
找到有 ADB 接口（FF/42/01）的设备（Windows 按设备接口 GUID `{F72FE0D4-CBCB-407D-8814-9ED673D0DD6B}`，Linux 读 sysfs），
发 CNXN，用 `~/.android/adbkey` 签名通过验证（没被允许过时把公钥发给手机，手机弹出「允许 USB 调试吗？」）。
电脑上有 adb 后台服务占着手机时，改经它的 5037 端口执行下面这些服务。连上后按顺序全自动执行（括号里是等价的 adb 命令）：

1. `shell:pm path com.p2d.mobile`：没有安装就用 `exec:cmd package install -r -S <大小>` 传入内置 APK（`adb install -r`）
2. `reverse:forward:tcp:39271;tcp:39271`（`adb reverse`）：之后手机连自己的 39271 端口时，adbd 发来 OPEN `tcp:39271`，电脑连本机的 39271 端口并双向转发
3. 生成随机令牌（32 位十六进制），通过 Deep Link 启动 App：

```
shell:am start -a android.intent.action.VIEW \
  -d 'p2d://connect?token=<令牌>&host=<电脑名>&os=<windows|linux>&port=39271' com.p2d.mobile
```

指定了包名，这个 Intent 只会投递给本 App。手机端收到 Deep Link 后立即连接。令牌按手机（`ro.serialno`）而不是按连接通道管理，手机的所有通道都断开后才作废，下次连接重新生成。

### 1.2 免调试连接（Android 配件模式 AOA，仅 Linux 电脑端）

手机没开 USB 调试时，电脑端（`desktop/core/internal/aoa`）用 Linux 的 usbfs 直接访问手机的 USB 设备，手机端由 `mobile/modules/p2d-accessory` 处理：

1. 电脑发现有 MTP（06/01/01）或 ADB（FF/42/01）接口的设备，发 `GET_PROTOCOL`（厂商请求 51）探测，支持的显示为「可以免调试连接」（开了 USB 调试的手机走上面的 USB 调试连接）。
2. 用户在电脑端点「免调试连接」（`POST /api/aoa/connect?id=<序列号>`），电脑记住这台手机（`aoa.json`，以后插上自动做这一步），发 6 个识别字符串（请求 52：厂商 `p2d`、型号 `P2D`、说明、版本 `1`、下载页地址、电脑标识）和启动请求（53）。
3. 手机断开重连成 `18D1:2D00`（配件模式），系统按 `res/xml/p2d_accessory_filter.xml` 弹出「用 P2D 打开」，用户确认后 App 打开配件，两边用接口 0 的一对 bulk 端点收发字节。
4. 管道上是多路复用帧（大端）：`0xA5 | 类型(1) | 流编号(4) | 长度(2) | 内容`，内容最长 8192 字节。

| 类型 | 方向 | 内容 |
|---|---|---|
| 1 HELLO | 手机 → 电脑 | `{"v":1,"nonce","name","app"}`，打开配件后每秒一次（也是心跳）；nonce 变了说明手机端重开过，旧流全部作废 |
| 2 CONFIG | 电脑 → 手机 | `{"v":1,"nonce","token","host","os","pcid"}`，同一次插线期间令牌不变 |
| 3 PONG | 电脑 → 手机 | 心跳回复（用户在电脑上点了「断开」后只回它、不再发 CONFIG） |
| 4 OPEN | 手机 → 电脑 | 手机本机回环端口（优先 39273）上来了一条 TCP 连接，电脑把它接到本机 39271 |
| 5 DATA | 双向 | 流数据 |
| 6 CLOSE | 双向 | 流已关闭 |
| 7 ACK | 双向 | 4 字节：已写给本机连接的字节数。每个流每个方向最多 256 KiB 在途，读管道的一方永远不会被某个流阻塞 |

手机收到 CONFIG 后拼成 `p2d://connect?token=…&host=…&os=…&port=<本机端口>&pcid=…`，和 adb 下发的 Deep Link 走同一套连接逻辑，所以会话、权限、自动配对 WiFi 都和 adb 通道一样，令牌按手机的 USB 序列号（即 `ro.serialno`）管理。

USB 细节：每次 bulk 写入不超过 15000 字节（对方每次读 16 KiB），长度正好是 512 的整数倍时拆成两次写，免得对方的读请求等不到短包。6 秒收不到对方的心跳就作废所有流，等重新握手。

### 1.3 WiFi：局域网直连

WiFi 连接不走 adb，而是手机直接连电脑的局域网 IP（详见第 9 节）。Deep Link 里额外带 `pcid`（电脑标识），手机 USB 连上后调用 `p2d/pc.info` 记下电脑的局域网地址，没配对过就调用 `p2d/pair.issue` 自动配对。拔掉数据线（令牌失效 / 连接断开）时，手机自动改用 WiFi 直连同一台电脑；插回数据线时电脑重新下发 Deep Link，手机切回 USB（可在手机「设备」页关闭）。

（之前的「adb 网络调试 + 自动 adb connect」方案已移除：它会让手机在局域网开着 5555 端口，且只能由电脑去连手机。）

开发调试时，Core 可以用 `--dev-token <值>` 指定一个固定令牌。

### 1.4 iPhone 数据线（经 usbmuxd）

iOS 没有 adb，也没有给 App 用的 USB 接口，电脑和 iPhone 之间经数据线通信只能走苹果的 usbmux 协议（`desktop/core/internal/usbmux`）：

1. 电脑端连系统的 usbmuxd（Mac 和 Linux 是 `/var/run/usbmuxd`，Windows 是 `127.0.0.1:27015`，要装「Apple 设备」或 iTunes），每 2 秒发一次 `ListDevices`，找出经 USB 插着的 iPhone（`ConnectionType` 为 `USB`）。usbmuxd 不可用、但系统里插着苹果的 USB 设备（厂商 ID `05AC`）时，状态接口的 `iphone.problem` 给出安装提示。
2. 对每台 iPhone 发 `Connect`（端口 39274，按大端放进整数），连到 iPhone 本机回环地址上 P2D App 监听的端口；App 没打开或在后台被挂起时 usbmuxd 返回「拒绝连接」，2 秒后重试。
3. 连上后这条连接就是「管道」，上面跑和 1.2 完全相同的帧格式、握手（HELLO / CONFIG / PONG）、流和流量控制（`desktop/core/internal/iphone` 复用 `internal/aoa` 的链路；手机端 `mobile/modules/p2d-accessory/ios/UsbmuxLink.swift`）。App 在本机另一个回环端口（优先 39273）接受 JS 的连接，每条连接对应一个流。
4. 令牌按 `ios:<UDID>` 管理，设备列表里 `transport` 为 `usbmux`、`platform` 为 `ios`。拔线（usbmuxd 列表里消失或编号变化）时作废令牌、断开会话；电脑上点「断开」后，拔线前不再发连接参数。

第一次在一台电脑上使用时，iPhone 上会弹出「要信任此电脑吗？」，点「信任」后才能连接。

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
| `standard` | 只读类 + `fs_write`、`fs_edit`、`input_mouse`、`input_keyboard`、`ui_act`、`window_activate` |
| `full` | 全部，包括 `shell_exec`、`fs_delete` |

四个开关再按类别收紧：`shell` → `shell_exec`；`fs` → `fs_*` 和 `doc_read`；`screen` → `screen_capture`、`ui_tree`；`input` → `input_*`、`ui_act`、`window_activate`。

连接建立后、收到 `p2d/setPermissions` 之前，默认 `readonly`。手机端应在 `initialize` 之后立即发送一次，用户修改设置时再次发送。

## 4. 电脑端工具（v1）

坐标统一是物理像素：电脑端启动时声明「每个显示器单独感知 DPI」（Win10 1703+；Win8.1 用 `SetProcessDpiAwareness`，Win7 退回 `SetProcessDPIAware`），截图、鼠标和界面元素的坐标在多个显示器缩放不同（如远程软件创建的 125% 虚拟屏 + 150% 主屏）、或改了缩放没有重新登录时也一致。

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
| `screen_capture` | `display?`（默认前台窗口所在的显示器），`region?`（`[x, y, 宽, 高]`，最近一次截图上的像素），`max_width?`（默认最宽 1280 且不超过约 100 万像素），`quality?`（默认 70） | 返回 JPEG 图片，外加一段文字说明显示器、系统缩放和换算关系：`屏幕坐标 = 截图坐标 ÷ scale + 偏移`。默认不超过约 100 万像素，因为 Claude、Qwen 等模型超过后会在服务端再缩小，模型给的坐标就对不上了。`region` 放大最近一次截图上的一块（小区域按整数倍放大到最多 3 倍）。电脑端记住最近一次截图（含放大图）的换算关系，供 `input_mouse` 的 `coords=screenshot` / `relative` 使用 |
| `input_mouse` | `action`：`move` / `click` / `double_click` / `right_click` / `middle_click` / `down` / `up` / `scroll` / `drag`；`x`、`y`；`to_x`、`to_y`（drag 用）；`dy`（scroll 用，正数向上）；`coords?`：`screen`（默认）/ `screenshot` / `relative` | 默认是屏幕坐标（虚拟桌面像素）；`coords=screenshot` 时 x、y、to_x、to_y 是最近一次 `screen_capture` 截图上的像素坐标，由电脑端换算（模型不用自己算，超出截图范围时报错）；`relative` 是最近一次截图上 0–1000 的相对位置（给习惯这样输出坐标的模型用）。点击类动作在点击前读取该位置的界面元素，结果里说明「点的位置是：按钮「发送」，在窗口「微信」里」，读不到时不说明 |
| `input_keyboard` | `action`：`type`（输入 `text`，支持中文）或 `key`（按组合键 `keys`，如 `ctrl+c`、`alt+f4`、`enter`） | |
| `ui_tree` | `window?`（标题包含即可；不填为前台窗口；`任务栏`），`name?`，`type?`，`list_windows?`，`max?`（默认 150） | 读取界面元素（控件树）：每行 `[类型] 名称 (x, y)`，坐标为元素中心的屏幕坐标；输入框附带当前值。窗口最小化时，只有同时满足 `ui_act` 的权限（`standard` 以上且开着 `input`）才会先还原，否则不动窗口、只返回提示。Windows 直接调用系统 UI Automation（COM，Win7 起都有）；Linux 暂不支持 |
| `window_activate` | `name`（程序名或窗口标题，包含即可；也可以是完整的进程名，如 `Weixin`） | 打开程序并切到前台：有窗口就还原并切到前台（同名窗口取没最小化、面积最大的那个，主窗口一般比登录框大）；没有窗口（关到托盘里了）就点任务栏托盘里同名的图标，图标收在「^」里时先展开再找，找完收起。托盘图标要名称完全相同或「名称 + 分隔符」开头（如 `QQ: 昵称`），避免「QQ」点到「QQ音乐」。都没有时按名称找到程序并启动：开始菜单和桌面的快捷方式（按显示的名称，系统程序用本地化名称，如「记事本」；也按快捷方式指向的程序名，如 `Weixin`；跳过卸载程序），再找 App Paths 注册表和 PATH；同名的进程已在运行（只是没有窗口）时不启动，启动后最多等 15 秒窗口出来。启动需要 `full` 权限且开着 `shell`，否则只返回找到的程序位置。找不到程序时返回错误，由模型改用 `shell_exec`。用于避免重复启动（微信 4.x 等重复启动会多开，弹出新的登录窗口）。只在 Windows 上可用 |
| `ui_act` | `name`，`action`：`click` / `set_value` / `focus` / `toggle` / `expand` / `collapse`；`window?`，`type?`，`index?`，`value?` | 按名称操作元素，不依赖坐标；同名时优先选支持该动作的元素。不支持的元素返回坐标，改用 `input_mouse` |

## 5. 远程桌面推流（自定义扩展）

| 方向 | 方法 | 说明 |
|---|---|---|
| 手机 → 电脑 | `p2d/screen.start` | 参数 `{ display?, maxWidth?（默认 1280，整帧最大 2560，分块最大 3840）, quality?（默认 60）, fps?（默认 10；整帧最大 30，分块最大 60，视频最大 120）, tiles?, video? }`，返回 `{ displays, tiles, video? }`。需要「查看屏幕」权限 |
| 手机 → 电脑 | `p2d/screen.stop` | 停止推流 |
| 电脑 → 手机 | `p2d/screen.frame`（通知） | `{ seq, data?, mimeType?, width, height, scale, x, y, cursorX?, cursorY?, display }` |
| 电脑 → 手机 | `p2d/screen.tiles`（通知） | 分块推流（`tiles: true` 时），见 5.2 |
| 手机 → 电脑 | `p2d/screen.ack`（通知） | `{ seq }`，分块帧画完了 / 视频帧显示完了 |
| 电脑 → 手机 | 二进制消息 `P2DV` | 硬件视频帧（`video` 时），见 5.3 |
| 电脑 → 手机 | `p2d/screen.cursor`（通知） | `{ x, y }`，视频流画面没变时单独更新鼠标位置 |
| 手机 → 电脑 | `p2d/screen.keyframe`（通知） | 视频解码器要关键帧 |
| 电脑 → 手机 | `p2d/screen.error`（通知） | `{ message }`，如锁屏时无法截图 |
| 电脑 → 手机 | `p2d/screen.stopped`（通知） | `{ reason }`，如权限被关闭 |

- **省带宽**：画面没有变化时只推送鼠标位置，不带 `data`，手机端继续显示上一帧；每 2 秒至少带一次完整画面。
- **坐标换算**：`屏幕坐标 = 图片坐标 ÷ scale + (x, y)`。
- **点击、输入**：远程桌面的点击和输入直接调用 `input_mouse`、`input_keyboard` 工具，受同样的权限控制。手机端按顺序发送（上一个返回后才发下一个），排队中的连续移动只保留最后一个、同一位置的连续滚动合成一次。
- **截屏方式（Windows）**：`BitBlt` 只在没有桌面合成时（Win7 关掉 Aero）才加 `CAPTUREBLT`：这个标志会让系统每截一帧都隐藏再显示一次鼠标，推流时电脑上的鼠标会一直闪；有桌面合成时不加它也能截到分层窗口。

### 5.1 黑屏

| 方向 | 方法 | 说明 |
|---|---|---|
| 手机 → 电脑 | `p2d/blank.set` | `{ on }`，返回 `{ on }`。打开时需要「键鼠」权限；系统不支持时返回错误和原因 |

- 电脑端（`desktop/core/internal/blank`）在每个显示器上盖一个全屏黑色窗口：置顶（每 0.4 秒重新提到最前）、鼠标点击穿透、不抢焦点，并用 `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` 排除在截屏之外，所以显示器上是黑的，推流和 `screen_capture` 照常看得到桌面。
- 需要 Windows 10 2004（内部版本 19041）及以上：更早的系统上这个标志会退化成「截屏里也是黑的」，所以不支持。
- 按会话计：任何一个会话要求黑屏就保持黑屏；会话断开时自动撤掉它的要求，都撤掉后恢复显示。状态接口里有 `blank: {supported, reason?, on?}`。
- 手机端按电脑记住选择（`PcDevice.blank`），每次连上这台电脑时重新发 `p2d/blank.set {on:true}`。

### 5.2 分块推流

整帧推流每帧都把整屏缩小成一张 JPEG，转成 base64 放进 JSON，手机端再用 React Native 的 `Image` 解码：清晰度只有一半（2560 宽的屏幕缩到 1280），手机解码也跟不上。手机端有原生画布（`mobile/modules/p2d-screen`）时改用分块推流：

- 手机端 `p2d/screen.start` 带 `tiles: true`，`maxWidth` 填手机屏幕的物理像素（如 3168）；电脑端不会放大，屏幕比这小就按原分辨率发。返回里 `tiles: true` 表示电脑端支持；旧版电脑端没有这个字段，手机端改用整帧参数（1280 宽）重新开始。
- 电脑端（`desktop/core/internal/screen/tiles.go`）把画面切成 256×256 的块，和上次发出去的像素逐块比较，只把变化的块编码成 JPEG（多核并行），打字、滚动一小块区域时只发几块。
- 通知 `p2d/screen.tiles`：`{ seq, full?, tiles: [{x, y, w, h, data}], width, height, scale, x, y, cursorX?, cursorY?, display, bytes, encoding }`。`x`、`y`、`w`、`h` 是编码后画面上的像素位置，`data` 是 JPEG base64；`full: true` 表示整屏（第一帧、切换显示器、分辨率变化）。画面和鼠标都没变时不发，每 2 秒发一次空帧（带鼠标位置）。
- 手机端把块交给原生画布：后台线程并行解码，按到达顺序画到和画面一样大的位图上，再刷新显示它的视图；画面数据不进 React 状态，页面只在尺寸、鼠标位置变化时重新渲染。画完回 `p2d/screen.ack {seq}`。
- 流控：电脑端最多 2 帧没确认，手机画得慢时电脑端少截几帧，不会越积越多、延迟越来越大；等确认最多 2 秒，超时照常发（防止确认丢失卡住推流）。
- 每分钟在电脑端日志里记一次「有变化的帧数、平均每帧大小」，以及截屏方式。
- 截屏：Windows 8 起用 DXGI 桌面复制（`internal/screen/dxgi_windows.go`，画面在显卡里，系统只在变化时给新的一帧），截一帧约 3～5 毫秒；Win7、远程桌面会话等打不开时用 GDI（2560×1600 一帧要 20～30 毫秒）。截屏和编码、发送在两个 goroutine 里同时做，截屏那边只留最新一帧。
- 推流期间用 `timeBeginPeriod(1)` 把系统计时器精度调到 1 毫秒（Go 1.20 在 Windows 上默认 15.6 毫秒，等 33 毫秒实际要 46 毫秒，30 帧/秒只能到 21 帧/秒），停止推流后恢复。

### 5.3 硬件视频流

JPEG 分块在整屏都变化时（视频、动态壁纸、拖动大窗口）每帧要几百 KB，60 帧/秒要 20 MB/秒以上。Windows 8 起、电脑有显卡硬件编码器、手机能硬件解码时改推 H.264 视频：

- 手机端（有原生视频模块时）`p2d/screen.start` 再带 `video: { codec: "h264", maxWidth, maxHeight, maxFps }`（手机硬件解码器的上限），`fps` 填想要的帧率。
- 电脑端（`internal/screen/h264_windows.go`、`internal/server/videostream.go`）：桌面复制拿到的画面留在显卡里，用 D3D11 视频处理器缩放并转成 NV12（BT.709、16～235），交给 Media Foundation 的硬件 H.264 编码器（NVIDIA NVENC、Intel Quick Sync、AMD），低延迟模式、不用 B 帧，关键帧只在开始和手机要的时候出。打开成功就回复 `video: { codec, width, height, encoder, bitrate }`；Win7、没有硬件编码器、打开失败（5 秒超时）时不带 `video`，按分块推流（`tiles: true`）继续。
- 视频帧是二进制 WebSocket 消息（局域网直连时同样经过加密层，帧类型为二进制）：4 字节 `P2DV` + 4 字节小端 JSON 长度 + JSON `{ seq, key?, width, height, scale, x, y, display, cursorX?, cursorY? }` + H.264 数据（Annex B，带起始码；关键帧带 SPS/PPS）。
- 手机端把数据交给原生解码器（Android：MediaCodec 硬件解码直接画到 TextureView，Android 11 起有低延迟模式时打开；iOS：AVSampleBufferDisplayLayer），显示完回 `p2d/screen.ack {seq}`。解码器还没建好、出错、显示视图重建后收到普通帧时，手机端发 `p2d/screen.keyframe`（最多每 0.5 秒一次）。
- 流控：最多 3 帧没确认。手机跟不上时电脑端少编几帧（不能丢已经编好的帧，丢了后面的就解不出来）；确认 2 秒没动静当作已确认。
- 码率：默认每像素每帧 0.12 比特（2376×1484、60 帧约 25 Mbps 上限，画面不动时几乎不占），每秒检查一次，经常因为等确认而不能编新画面就降 20%（最低 1.5 Mbps），顺畅时每秒升 10% 回到默认。
- 画面停下来 0.3 秒后，把最后一帧再编 2 次，把运动时降下去的画质补回来。
- 画面没变时，鼠标位置单独用 `p2d/screen.cursor { x, y }` 通知。
- 每分钟在电脑端日志里记一次帧数、平均每帧大小、实际码率和当前码率上限。

## 6. 文件上传（自定义扩展）

用户在 Agent 对话里添加的文件、用户要求存到电脑的图片（`save_attachment_to_pc` 工具；图片默认只发给模型看，不存到电脑），还有 Agent 用手机网络下载的驱动、安装包（`download_to_pc` 工具），由手机分块上传到电脑，保存在系统「下载」目录下的 `P2D` 文件夹（Windows：`%USERPROFILE%\Downloads\P2D`；Linux：`XDG_DOWNLOAD_DIR`，通常是 `~/下载/P2D`）。需要「读写文件」开关和「标准」以上权限。

| 方法 | 参数 | 返回 |
|---|---|---|
| `p2d/upload.begin` | `{ name, size }` | `{ id, path }`：创建文件，同名时自动改名为 `名称 (1).扩展名` |
| `p2d/upload.chunk` | `{ id, data }`（base64，建议每块 256 KB） | `{ written }`：按顺序追加 |
| `p2d/upload.end` | `{ id, verify? }` | `{ path, size, sha256, sha1, signature? }`：大小与 `begin` 声明的不一致时报错并删除文件。`verify: true` 时 Windows 上用 `Get-AuthenticodeSignature` 检查数字签名，`signature` 为 `状态|签名者`，如 `Valid|CN=Microsoft ...` |
| `p2d/upload.cancel` | `{ id }` | 删除未完成的文件 |

- 文件名会去掉路径和系统不允许的字符，最大 1 GB。
- 连接断开时，未完成的上传会被删除。
- 上传完成后，手机把保存路径告诉模型，Agent 再用 `fs_read`、`doc_read` 等工具处理。

### 6.1 读取文件（电脑之间传文件用）

| 方法 | 参数 | 返回 |
|---|---|---|
| `p2d/file.read` | `{ path, offset?, size? }`（`size` 默认 512 KB，最大 1 MB） | `{ path, data, offset, size, eof }`：`data` 是 base64，`path` 是绝对路径，`size` 是文件总大小 |

- 需要「读写文件」开关（只读权限也可以）；任意文件都能读，包括二进制文件。
- 手机同时连着多台电脑时，`pc_copy_file` 工具用它从源电脑按块读，原样用 `p2d/upload.*` 传到目标电脑（手机不解码、不落盘）。旧版电脑端没有这个方法（返回 -32601），手机会提示先更新电脑端。

### 6.2 同时连接多台电脑

手机除了「当前电脑」（USB 或 WiFi），还可以用局域网直连（`/p2d/secure`，见第 9 节）同时连几台配对过的电脑，每台一条独立的连接，权限设置相同。电脑端不需要特别支持：每台电脑看到的仍然只有一部手机。

- 只连一台时，工具清单原样交给模型。
- 连多台时，每个电脑工具多一个必填参数 `pc`（电脑名，`enum` 列出能用这个工具的电脑），手机按它把调用转给对应的电脑，结果开头加上「【电脑名】」。`download_to_pc` 也多一个 `pc`（传到哪台），另外多一个 `pc_copy_file`（`from`、`path`、`to`）。
- 同一轮里不同电脑的工具调用同时执行，同一台电脑上的按顺序执行；手机端工具和扩展按顺序执行。

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

- `GET /api/status`：电脑信息、能否经 USB 调试连接（`adbAvailable`，不能时 `adbError` 说明原因）、设备列表（序列号、型号、阶段）、当前会话；Windows 上有已插上但缺 USB 驱动的手机时带 `driverMissing: [{name, instanceId}]`；系统防火墙会挡住局域网直连端口时（银河麒麟）带 `lanBlocked: true`；`lan.tailscale` 是本机的 Tailscale 地址（100.64.0.0/10，装了 Tailscale 才有，它也在 `lan.addrs` 里，排在真实网卡后面）
- `POST /api/disconnect`：断开所有手机。设备在拔线前不会自动重连。连着的会话以 WebSocket 关闭码 **4409**（原因「电脑端已断开连接」）关闭，手机收到后不再自动重连，显示「电脑端已断开」；局域网连接在手机手动点「连接」前也会被拒（手机同样按 4409 处理）。只有令牌无效（401 / 4401）才提示重新插拔数据线或重新配对
- `POST /api/aoa/connect?id=<序列号>`（Linux）：免调试连接一台手机（见 1.2），返回 `{ok, message?}`。状态接口里免调试连接的设备 `transport` 为 `aoa`，`stage` 多一个 `available`（可以点「免调试连接」）；开启时带 `aoa: {enabled, problem?}`
- iPhone 数据线（见 1.4）：状态接口带 `iphone: {enabled, problem?}`，设备 `transport` 为 `usbmux`、`platform` 为 `ios`；Core 的 `-no-iphone` 参数可以关掉
- `POST /api/driver/install`（Windows）：以管理员身份（弹出 UAC）安装电脑端自带的 ADB 接口驱动（WinUSB，按兼容标识 `USB\Class_FF&SubClass_42&Prot_01` 匹配所有品牌手机），等安装结束返回 `{ok, message?}`。已装厂商驱动的手机不受影响
- `POST /api/firewall/allow`（银河麒麟）：用 `pkexec` 弹出系统的密码框，执行 `kylin-firewall -A p2d -d inbound -m all -p tcp -L <局域网端口> -a allow`（规则已存在但被关掉时改为重新开启），公用、专用两种网络模式都放行，等结束返回 `{ok, message?}`

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

文件存在手机上；`skill_run` 时按内容哈希同步到电脑缓存目录（`<用户缓存目录>/p2d/skills/<名称>-<哈希>/`，可用环境变量 `P2D_SKILL_DIR` 覆盖），再用 `shell_exec` 执行（受「执行命令」权限控制）。

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

电脑端在 `0.0.0.0:39272`（`-lan-port`，0 表示关闭）提供局域网入口，只有三个路径：`/p2d/ping`（探测，返回 `{app:"p2d", pc, name, os, osName}`；手机端「附近的电脑」扫描所在 /24 网段的这个地址来发现电脑）、`/p2d/pair`（配对）、`/p2d/secure`（加密会话）。状态接口等仍只接受本机访问。电脑身份和配对过的手机保存在用户配置目录 `p2d/lan.json`（仅当前用户可读）。

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

1. 手机 → `{type:"hello", phone, nc(16 字节随机), manual, ciphers?}`（新版手机端带 `ciphers: ["aes-gcm", "chacha20-poly1305"]`）；未配对返回 `{type:"error", code:"unpaired"}`；电脑端点过「断开」时只接受 `manual:true`（用户手动点连接），否则返回 `suppressed`。
2. 电脑 → `{type:"hello", pc, name, os, osName, ns(16 字节随机), cipher?}`。手机端支持 `aes-gcm` 时电脑端回 `cipher:"aes-gcm"`，之后改用 AES-256-GCM（密钥、nonce、帧格式与 ChaCha20 相同）：手机上 AES 有硬件加速、由系统原生实现，纯 JavaScript 的 ChaCha20 在手机上解密一帧虚拟桌面画面要上百毫秒。旧版两端都不带这个字段，仍用 ChaCha20。`osName` 是简短的系统名（如 `Windows 11`、`Kylin V10 SP1`），手机端据此显示系统图标；`p2d/pc.info` 和配对结果里也有。
3. `c2s ‖ s2c = HKDF(K, salt=nc‖ns, info="p2d secure v1", 64)`。之后每条消息都是二进制帧：`ChaCha20-Poly1305(密钥, nonce = 4 字节 0 + 8 字节大端计数器, 明文 = 帧类型(1 文本 / 2 二进制) ‖ 内容)`，两个方向各自从 0 计数。解密失败（密钥不对、篡改、重放）直接断开。
4. 解开后的内容就是普通的 MCP JSON-RPC，和 USB 的 `/mcp` 完全一样。会话的 `serial` 为 `lan:<手机ID>`，`route` 为 `wifi`。

手机在握手 `initialize` 的 `clientInfo` 里带 `deviceId`（手机标识）和 `device`（手机名），电脑上运行的 MCP 进程按手机标识归属，USB / WiFi 切换后继续使用。

测试向量见 `desktop/core/internal/lan/crypto_test.go` 和 `mobile/tests/secure.test.ts`（两端必须一致）。
