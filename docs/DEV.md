# 开发说明

## 目录

| 目录 | 内容 |
|---|---|
| `desktop/core/` | 电脑端核心服务（Go 1.20，MCP 服务端 + adb 自动连接） |
| `mobile/` | 手机端 App（Expo + expo-router + NativeWind） |
| `docs/` | 方案 [PLAN.md](PLAN.md)、协议 [PROTOCOL.md](PROTOCOL.md) |
| `preview/` | 界面预览（静态 HTML） |
| `scripts/` | 构建脚本 |
| `.tools/` | 本地工具链（Go 1.20.14），不入库 |

## 电脑端

```bash
# 交叉编译全部平台，输出到 dist/core/<系统>-<架构>/
bash scripts/build-core.sh 0.1.0-dev

# 单元测试
cd desktop/core && ../../.tools/go/bin/go test ./...

# 本机调试：固定令牌，不启用 adb 设备发现
dist/core/windows-amd64/p2d-core.exe -dev-token e2etoken -no-adb
```

- 必须用 **Go 1.20.x** 编译，否则 Windows 7 无法运行。
- 正式运行时，adb 和手机端安装包从程序目录读取：`vendor/adb/adb(.exe)`、`vendor/app/p2d.apk`。找不到内置 adb 时会使用 PATH 中的 adb（开发环境）。
- 状态接口：`GET http://127.0.0.1:39271/api/status`

## 手机端

```bash
cd mobile
npx tsc --noEmit                    # 类型检查
npm test                            # MCP 客户端单元测试
npx tsx tests/integration.core.ts   # 与正在运行的电脑端联调（需先用 -dev-token e2etoken 启动 p2d-core）
npx tsx tests/integration.agent.ts  # Agent 循环 + 真实电脑端 + 按脚本调用工具的假模型
npx expo start                      # 开发服务器
```

### 构建 APK（Windows）

```bash
cd mobile && npx expo prebuild --platform android --no-install && cd ..
P2D_PROXY=127.0.0.1:1159 bash scripts/build-apk.sh arm64-v8a   # 不需要代理时去掉 P2D_PROXY
```

- 输出 `dist/app/p2d.apk`，并复制到 `desktop/vendor/app/p2d.apk`（电脑端插线时自动安装）。
- C++ 组件的编译路径很长，脚本会先把 `mobile/` 同步到较短的路径 `D:\project_resource\p2dm`（可用 `P2D_BUILD_DIR` 修改）再构建。
- 需要系统开启长路径（注册表 `HKLM\SYSTEM\CurrentControlSet\Control\FileSystem\LongPathsEnabled = 1`），并安装 CMake 3.31.6：下载 https://dl.google.com/android/repository/cmake-3.31.6-windows.zip ，解压到 `%LOCALAPPDATA%\Android\Sdk\cmake\3.31.6\`（解压后该目录下直接是 `bin\`、`share\`）。SDK 自带的 CMake 3.22.1 里的 ninja 不支持长路径。
- 目前使用调试签名，正式发布前要换成自己的签名证书。

## 已知待办

- **adb 版本与 Win7**：本机 platform-tools 为 37.x，较新的 adb 可能已不支持 Win7，打包前需要选定能在 Win7 运行的 adb 版本并实测；arm64 / loong64 版 adb 需要自行编译（见 PLAN.md 5.1）。
- **真机验证**：已在小米 9（Android 15）+ Windows 10 上跑通自动安装、自动连接、App 被关闭后自动重连、远程桌面。Agent 工具调用还没有用真实大模型在真机上测过。
- **App 升级**：电脑端只在手机上没装 App 时安装，内置 APK 版本更新后不会自动覆盖安装（需要比较 versionCode）。
- **OCR**：模型不支持图片（如 DeepSeek）时，截图应先在手机上做文字识别再交给模型，目前还没接入（`src/agent/conversations.ts` 中的 TODO）。
- **真实大模型**：Agent 只用假模型测试过，还没用真实的 OpenAI / DeepSeek 接口跑过。
- **Linux**：麒麟上的截图（X11）和键鼠（XTest）只完成了交叉编译，还没在实机上测试。

## 电脑端界面（desktop/app）

Electron 22.3.27（最后支持 Win7）+ React 18 + Tailwind CSS v3，Vite 构建。主进程负责启动 Core、每秒轮询 `/api/status`、托盘、被控红框和断开热键（依次尝试 `Ctrl+Alt+Q`、`Ctrl+Alt+Shift+Q`、`Ctrl+Shift+F12`，使用第一个未被占用的）。

```bash
cd desktop/app
npm install --ignore-scripts        # Electron 二进制见下方说明
npm run typecheck                   # 类型检查（渲染进程 + 主进程）
npm run dev                         # 生成图标、构建并以开发模式启动（使用仓库根目录 dist/core 下的 Core）
npm run dist:win64                  # 打包 Windows x64 便携版，输出到 release/
```

- **Electron 二进制**：本机代理环境下 Electron 自带的下载器会 TLS 握手失败。可以手动从 `https://cdn.npmmirror.com/binaries/electron/22.3.27/` 下载 `electron-v22.3.27-win32-x64.zip`，解压到 `node_modules/electron/dist/`，再写入 `node_modules/electron/path.txt`（内容为 `electron.exe`）。
- **打包时**：设置 `ELECTRON_BUILDER_BINARIES_MIRROR=https://cdn.npmmirror.com/binaries/electron-builder-binaries/`；x64 可加 `-c.electronDist=node_modules/electron/dist -c.electronVersion=22.3.27` 复用已下载的 Electron。打包前需先运行 `bash scripts/build-core.sh`，`stage-core` 会把各平台 Core 复制到 `core-bin/`。
- **开发用环境变量**（打包后同样生效，但只在调试时使用）：
  - `P2D_CORE_ARGS`：传给 Core 的额外参数，如 `-dev-token e2etoken`、`-no-adb`
  - `P2D_PORT`：改用其他端口（同时传给 Core），避免与正在运行的 Core 冲突
  - `P2D_CORE_PATH`：指定 Core 可执行文件
  - `P2D_DEBUG_CAPTURE`：每 2 秒把主窗口画面写入该目录下的 `main.png`（仅开发模式）
