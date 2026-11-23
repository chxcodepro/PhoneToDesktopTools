# 预存的第三方文件（不入库）

打包电脑端时，`desktop/app/scripts/stage-core.mjs` 会把这里的文件和 Core 一起放进安装包，使电脑不联网也能用。

```
desktop/vendor/
├── adb/
│   ├── windows-amd64/   adb.exe、AdbWinApi.dll、AdbWinUsbApi.dll（adb 33.0.3）+ 通用 C 运行库 43 个 DLL
│   ├── windows-386/     同上（adb 是 32 位程序，两个目录内容相同）
│   ├── linux-amd64/     adb（麒麟 x86_64）
│   └── linux-arm64/     adb + lib/（麒麟 arm64：麒麟软件源里的 adb 8.1 和它用到的 6 个 Android 库）
└── app/
    └── p2d.apk          手机端安装包（mobile 构建产物）
```

龙芯版没有 adb：麒麟和龙芯（Loongnix）的软件源里都没有旧世界 LoongArch 的 adb，龙芯版目前只能用 WiFi 连接；系统里装了 adb 时电脑端会自动使用。

运行 `bash scripts/fetch-vendor.sh` 会自动下载 adb 和 Windows 运行库到这里并核对 SHA-256（GitHub 构建也用它）；手机端安装包由 `scripts/build-apk.sh` 生成。Windows 版 adb 必须用 **33.0.3**：更新的版本用到了 Win8 / Win10 才有的系统函数，在 Win7 上启动失败或连接手机时崩溃（实测结果见 TESTING.md 1.5）。

### Windows 通用 C 运行库（UCRT）

adb 33.0.3 依赖通用 C 运行库。Win10 / 11 系统自带；Win7 要装过系统更新 KB2999226 才有，没打补丁的 Win7 会缺。
所以把运行库放在 adb.exe 旁边（微软支持的「随程序部署」方式）：Win7 上 adb 优先加载这里的副本，Win10 / 11 上系统会忽略它们、照常用系统自带的。

- 来源：微软官方 NuGet 包 `Microsoft.Windows.SDK.CPP` 10.0.19041.5 中的 `c/Redist/10.0.19041.0/ucrt/DLLs/x86/`，共 43 个文件（`ucrtbase.dll` 版本 10.0.19041.1），均有微软的有效数字签名。
  下载地址：https://api.nuget.org/v3-flatcontainer/microsoft.windows.sdk.cpp/10.0.19041.5/microsoft.windows.sdk.cpp.10.0.19041.5.nupkg
- 许可：Windows SDK 许可协议（https://aka.ms/WinSDKLicenseURL），`Redist` 目录下的 UCRT DLL 属于允许随软件分发的文件。
- 两个目录都放 x86 版本，因为 adb 本身是 32 位程序。
- 在 Win7 上实测过：adb 加载的 `ucrtbase.dll` 和 `api-ms-win-crt-*.dll` 都来自这个目录。

### 麒麟 arm64 的 adb

Google 不提供 Linux arm64 的 adb。这里用银河麒麟 V10 SP1 官方软件源（`archive.kylinos.cn`，`10.1-2403-updates`）里的 `adb 1:8.1.0+r23-5kylin2k0.2` 和它依赖的 `android-libadb`、`android-libbase`、`android-libcutils`、`android-libcrypto-utils`、`android-liblog`、`android-libboringssl`，共 7 个 arm64 包，`fetch-vendor.sh` 逐个核对 SHA-256 后解出 adb 和 `lib/*.so.0`。

- 电脑端运行 adb 时把 `lib/` 加进 `LD_LIBRARY_PATH`，所以离线的麒麟电脑不用 apt 安装任何东西；libusb、libudev、libstdc++ 是麒麟桌面系统自带的。
- 同一版本的 x86_64 adb 是麒麟预装的，实测能识别一加 13（Android 16）、拉起手机端并连接、远程桌面推流。
- 许可：Apache License 2.0（AOSP），与 Google 发布的 platform-tools 相同的源码。
