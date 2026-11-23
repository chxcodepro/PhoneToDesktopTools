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
- 默认用调试签名；设置了下面「正式签名」的环境变量就用你自己的证书。

### 正式签名

签名配置由 `mobile/plugins/withReleaseSigning.js` 在 prebuild 时写进 `app/build.gradle`，证书和密码只在构建时从环境变量读取，不会写进任何文件：

| 环境变量 / GitHub Secret | 内容 |
|---|---|
| `P2D_KEYSTORE_FILE`（本地） / `P2D_KEYSTORE_BASE64`（GitHub） | 证书文件的路径 / 证书文件的 base64 |
| `P2D_KEYSTORE_PASSWORD` | 证书库密码 |
| `P2D_KEY_ALIAS` | 密钥别名 |
| `P2D_KEY_PASSWORD` | 密钥密码 |

生成证书（只做一次，证书文件和密码要妥善保存，丢了以后就没法给已装的 App 发更新）：

```bash
keytool -genkeypair -v -keystore p2d-release.jks -alias p2d -keyalg RSA -keysize 2048 -validity 10000
base64 -w0 p2d-release.jks   # 输出填进 GitHub Secret P2D_KEYSTORE_BASE64
```

GitHub 上在仓库「Settings → Secrets and variables → Actions」里添加上表 4 个 Secret。没有配置时继续用调试签名。

注意：从调试签名换成正式签名后，签名变了，电脑端没法覆盖安装已装的旧版（日志里会说明「签名不同，跳过更新」），需要在手机上卸载一次旧版。所以最好在正式发给用户之前就换好。

## GitHub 构建

推送到 GitHub 后，`.github/workflows/build.yml` 自动测试并构建全部可执行文件：

| 产物（Actions 页面的 Artifacts） | 内容 |
|---|---|
| `core` | 电脑端核心，5 个平台（Windows x64 / x86，Linux x64 / arm64 / loong64） |
| `apk` | 手机端 APK（arm64-v8a + armeabi-v7a） |
| `desktop-win` | 电脑端便携版 exe（x64、ia32），已内置 adb、运行库和 APK |
| `desktop-linux` | 电脑端 deb 和 tar.gz（x64、arm64、龙芯），AppImage（x64、arm64） |

- 每次推送和 PR 都会跑；产物保留 14 天。版本号为 `0.1.0-ci.<运行编号>`。
- 推送 `v` 开头的标签（如 `git tag v0.1.0 && git push origin v0.1.0`）会另外创建 GitHub Release，附上以上所有文件，版本号取标签。**检查更新只认 Release**：平时推送的 `ci` 构建不会被检查到，要让用户收到更新就打标签。版本号要比上一个标签大（`0.1.0` 比 `0.1.0-ci.N` 新）。
- APK 的 versionName 是构建版本号，versionCode 是运行编号（递增，保证新包能覆盖安装旧包）。
- adb 和 Windows 运行库由 `scripts/fetch-vendor.sh` 在构建时下载，逐个文件核对 SHA-256（运行库的校验值在 `scripts/ucrt-x86.sha256`）。本地打包前也可以运行它准备 `desktop/vendor/`。
- `mobile/android/` 不入库，构建时用 `expo prebuild` 重新生成。电脑端靠覆盖安装给手机更新 App，所以 APK 的签名必须和手机上已装的一致。
- 签名：配置了「正式签名」的 4 个 Secret 就用正式证书；没配置时用调试签名，并核对调试证书和本地构建的一致，不一致时给出警告。除此之外不需要配置任何密钥。

## 已知待办

- **adb**：Windows 和 Linux x86_64 用 33.0.3（Win7 实测结论见 TESTING.md 1.5）；麒麟 arm64 用麒麟软件源里的 adb 8.1 和它的 6 个库（见 desktop/vendor/README.md）；龙芯没有可用的 adb，只能 WiFi 连接。`bash scripts/fetch-vendor.sh` 会下载并核对。
- **真机验证**：已在小米 9（Android 15）、一加 PJZ110（Android 17）+ Windows 10 上跑通自动安装、自动连接、自动重连、远程桌面、WiFi 直连，以及用 DeepSeek 驱动 Agent 操作电脑。
- **OCR（iOS）**：Android 已用 ML Kit 中文模型离线识别（`modules/p2d-ocr`）；iOS 还没实现（可用 Vision 的 `VNRecognizeTextRequest`），目前 iPhone 上看不到图片的模型拿不到截图文字。
- **麒麟**：x86_64 虚拟机上全部功能实测通过（TESTING.md 2.4）；arm64、龙芯没有真机，未实测。

## 麒麟各 CPU

| CPU | 架构 | 核心 | 界面 | adb | 安装包 |
|---|---|---|---|---|---|
| 兆芯、海光、Intel | x86_64 | 上游 Go 1.20 | Electron 22（官方） | 33.0.3（官方） | deb、AppImage |
| 飞腾、鲲鹏、海思麒麟 | arm64 | 上游 Go 1.20 | Electron 22（官方） | 8.1（麒麟软件源） | deb、AppImage |
| 龙芯 3A5000 / 3A6000 | loongarch64（旧世界） | 龙芯旧世界 Go 1.20.12 | 龙芯 Electron 22.3.27 | 没有，只能 WiFi | deb |
| 龙芯 3A4000 | mips64el | — | 没有 Electron 22 | 没有 | 不支持 |
| 申威 | sw64 | 上游 Go 不支持 | 没有 | 没有 | 不支持 |

- 麒麟 V10 的龙芯版是「旧世界」：信号处理的 `ucontext` 结构、信号集大小都和上游 Go 假设的「新世界」不同，上游 Go 编出的程序收到信号就会出错，所以必须用龙芯的旧世界 Go（`scripts/fetch-loong-go.sh`，只有 linux-amd64 版，所以龙芯版只在 GitHub 构建里编译）。
- `scripts/package-linux.sh` 把 electron-builder 的 `linux-*-unpacked` 打成 deb 和 tar.gz；龙芯版在 x64 目录基础上换成龙芯 Electron 和龙芯核心。
- 麒麟 KySec 执行控制只放行 dpkg 安装的程序（「警告」模式会先询问），所以交付用 deb，不用 AppImage。安装步骤见 [INSTALL.md](INSTALL.md)。

## 手机端自动更新

电脑端每次通过数据线连上手机时，比较内置安装包（`-apk`）和手机上已装 App 的 SHA-256（手机上用 `sha256sum` 计算 `pm path` 得到的 base.apk），不同就 `adb install -r` 覆盖安装，装完重新拉起 App。不需要手动改版本号；手机上的版本更新（降级被拒）或签名不同（如装过开发版）时跳过更新，继续使用手机上的版本，日志里会说明原因。被拒绝过的组合（手机上的包 + 内置包的哈希）在 Core 运行期间记住，之后插线不再重复推送安装包。

## 检查更新

- 电脑端：启动 15 秒后和之后每 12 小时自动查一次 `https://api.github.com/repos/<仓库>/releases/latest`，有新版本时主窗口顶部显示提示；窗口底部「检查更新」和托盘菜单可以手动查。按系统和 CPU 找对应的安装包（命名规则见 `desktop/app/src/electron/update.ts` 的 `assetSuffixes`），点「下载新版本」用浏览器下载，用户自己覆盖安装。自动检查失败（不能上网）时不提示。
- 手机端：「设置 → 关于 → 检查更新」，找发布里 `-android.apk` 结尾的文件，用浏览器下载安装。插数据线连接电脑时电脑端也会自动更新手机（见上一节）。
- 查询的仓库不写在代码里：CI 打包时把 `GITHUB_REPOSITORY` 写进电脑端 `package.json` 的 `p2d.updateRepo` 和手机端 `app.json` 的 `expo.extra.updateRepo`。本地打包的版本没有这个字段，检查更新会提示「没有配置更新地址」。
- 版本比较：`0.2.0` > `0.1.0` > `0.1.0-ci.12` > `0.1.0-ci.5`。

## 文字识别（OCR）

模型不支持图片时（「设置 → 模型」里关掉了「支持图片」，或接口在运行中拒收图片后自动降级），截图在手机上离线识别成文字。新版 DeepSeek（如 deepseek-flash）实测能看图，默认直接发图片。`modules/p2d-ocr` 是项目内的 Expo 本地模块（Android ML Kit `text-recognition-chinese`，模型打包在 APK 里，不依赖 Google Play 服务）。识别结果在 `src/agent/ocr.ts` 里按阅读顺序排好，并用 `screen_capture` 返回的换算公式直接给出屏幕坐标，模型可以拿来点击。此时截图会用更高分辨率（宽 2560、画质 85）获取，只传到手机，不发给模型。用户发的图片附件也会先识别文字再交给模型。

ML Kit 的依赖在 dl.google.com，下载超时时可手动下载，放进本机 Maven 仓库（`scripts/gradle-local-repo.gradle` 让构建优先从 `~/.m2/repository` 查找），例如：
`https://dl.google.com/dl/android/maven2/com/google/mlkit/text-recognition-bundled-common/17.0.0/text-recognition-bundled-common-17.0.0.aar` → `~/.m2/repository/com/google/mlkit/text-recognition-bundled-common/17.0.0/`（同目录要有对应的 .pom）。

## 电脑端界面（desktop/app）

Electron 22.3.27（最后支持 Win7）+ React 18 + Tailwind CSS v3，Vite 构建。主进程负责启动 Core、每秒轮询 `/api/status`、托盘、被控红框、断开热键和开机自启（依次尝试 `Ctrl+Alt+Q`、`Ctrl+Alt+Shift+Q`、`Ctrl+Shift+F12`，使用第一个未被占用的）。

```bash
cd desktop/app
npm install --ignore-scripts        # Electron 二进制见下方说明
npm run typecheck                   # 类型检查（渲染进程 + 主进程）
npm run dev                         # 生成图标、构建并以开发模式启动（使用仓库根目录 dist/core 下的 Core）
npm run dist:win64                  # 打包 Windows x64 便携版，输出到 release/
```

- **Electron 二进制**：本机代理环境下 Electron 自带的下载器会 TLS 握手失败。可以手动从 `https://cdn.npmmirror.com/binaries/electron/22.3.27/` 下载 `electron-v22.3.27-win32-x64.zip`，解压到 `node_modules/electron/dist/`，再写入 `node_modules/electron/path.txt`（内容为 `electron.exe`）。
- **打包时**：设置 `ELECTRON_BUILDER_BINARIES_MIRROR=https://cdn.npmmirror.com/binaries/electron-builder-binaries/`；x64 可加 `-c.electronDist=node_modules/electron/dist -c.electronVersion=22.3.27` 复用已下载的 Electron。打包前需先运行 `bash scripts/build-core.sh`，`stage-core` 会把各平台 Core 复制到 `core-bin/`。
- **开机自启**（`src/electron/autostart.ts`）：只在打包后生效，第一次运行默认开启，选择存在 `userData/settings.json`。Windows 用 `reg add` 写 `HKCU\...\Run\PhoneToDesktop`（路径带引号，便携版登记 exe 本身而不是临时解压目录），Linux 写 `~/.config/autostart/phonetodesktop.desktop`；都带 `--hidden`，开机后只在托盘。每次启动按选择重新登记，exe 换位置也能跟上。
- **开发用环境变量**（打包后同样生效，但只在调试时使用）：
  - `P2D_CORE_ARGS`：传给 Core 的额外参数，如 `-dev-token e2etoken`、`-no-adb`
  - `P2D_PORT`：改用其他端口（同时传给 Core），避免与正在运行的 Core 冲突
  - `P2D_CORE_PATH`：指定 Core 可执行文件
  - `P2D_DEBUG_CAPTURE`：每 2 秒把主窗口画面写入该目录下的 `main.png`（仅开发模式）
