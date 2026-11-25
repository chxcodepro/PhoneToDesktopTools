# 预存的文件（不入库）

打包电脑端时，`desktop/app/scripts/stage-core.mjs` 会把这里的文件和 Core 一起放进安装包，使电脑不联网也能给手机装 App。

```
desktop/vendor/
└── app/
    └── p2d.apk          手机端安装包（mobile 构建产物，由 scripts/build-apk.sh 或 GitHub 构建生成）
```

电脑端不再带 adb：开了 USB 调试的手机由电脑端自己经 USB 连接（`desktop/core/internal/adbwire`，Windows 用系统自带的 WinUSB，
Linux 用内核的 usbfs），所有平台（含 Win7、32 位、麒麟 arm64 和龙芯）都一样。以前随包带的 adb 33.0.3、Windows 通用 C 运行库和麒麟 arm64 的 adb 都已去掉。
