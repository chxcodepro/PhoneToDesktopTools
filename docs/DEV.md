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
npx expo start                      # 开发服务器
```

## 已知待办

- **adb 版本与 Win7**：本机 platform-tools 为 37.x，较新的 adb 可能已不支持 Win7，打包前需要选定能在 Win7 运行的 adb 版本并实测；arm64 / loong64 版 adb 需要自行编译（见 PLAN.md 5.1）。
- **APK 构建**：还没有执行 `expo prebuild` 和构建 APK。构建出 `p2d.apk` 后放到 `vendor/app/`，电脑端就能自动安装。
- **真机验证**：adb 自动连接流程（自动安装、建立隧道、Deep Link 下发令牌）还没在真实手机上跑过。
- **Linux**：麒麟上的截图（X11）和键鼠（XTest）只完成了交叉编译，还没在实机上测试。
