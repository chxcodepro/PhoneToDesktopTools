# PhoneToDesktop 手机端

Expo（SDK 58）+ expo-router + TypeScript，界面用 NativeWind v4 + react-native-reusables 风格组件（`src/components/ui/`）。
协议见 [docs/PROTOCOL.md](../docs/PROTOCOL.md)。

## 目录

```
src/
├── app/                 # 路由（expo-router）
│   ├── _layout.tsx      # 根布局：加载本地设置、处理 p2d:// 链接
│   ├── connect.tsx      # 插线自动连接页（p2d://connect?token=… 打开）
│   └── (tabs)/          # 底部 4 个标签：Agent / 远程桌面 / 扩展 / 设置
├── protocol/            # 纯 TS，不依赖 RN：MCP 客户端、Deep Link 解析、类型
├── state/               # 连接管理、本地存储
├── agent/presets.ts     # 大模型预设（地址为占位符）
└── components/          # 页面组件与 ui/ 基础组件
tests/                   # Node 测试（ws 假服务端）
```

## 常用命令

```bash
npm test            # mcpClient / Deep Link 测试
npm run typecheck   # tsc --noEmit
npx expo lint       # ESLint
npx expo-doctor     # 依赖与配置检查
npx expo run:android  # 生成原生工程并安装到真机（需要 Android SDK）
```

## 手动模拟电脑端下发连接

手机通过 USB 连上电脑后：

```bash
adb reverse tcp:39271 tcp:39271
adb shell am start -a android.intent.action.VIEW -d 'p2d://connect?token=<令牌>&host=DESKTOP-01&os=windows&port=39271' com.p2d.mobile
```

令牌需与电脑端 Core 的 `--dev-token` 一致。

## 需要填写的占位符

- `src/agent/presets.ts`：`<OPENAI_BASE_URL>`、`<DEEPSEEK_BASE_URL>`
- 设置页里的 API Key、自定义接口地址、模型名（运行时填写）
