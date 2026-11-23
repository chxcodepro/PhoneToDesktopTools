# 预存的第三方文件（不入库）

打包电脑端时，`desktop/app/scripts/stage-core.mjs` 会把这里的文件和 Core 一起放进安装包，使电脑不联网也能用。

```
desktop/vendor/
├── adb/
│   ├── windows-amd64/   adb.exe、AdbWinApi.dll、AdbWinUsbApi.dll（64 位 Win7/10/11）
│   ├── windows-386/     同上，32 位 Win7 需要能在 32 位系统运行的旧版 adb
│   ├── linux-amd64/     adb（麒麟 x86_64）
│   ├── linux-arm64/     adb（麒麟 arm64，需自行编译，见 PLAN.md 5.1）
│   └── linux-loong64/   adb（麒麟龙芯，需自行编译）
└── app/
    └── p2d.apk          手机端安装包（mobile 构建产物）
```

下载地址见 [docs/TESTING.md](../../docs/TESTING.md)。Windows 版 adb 必须用 **33.0.3**：更新的版本用到了 Win8 / Win10 才有的系统函数，在 Win7 上启动失败或连接手机时崩溃（实测结果见 TESTING.md 1.5）。
