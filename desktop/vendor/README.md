# 预存的第三方文件（不入库）

打包电脑端时，`desktop/app/scripts/stage-core.mjs` 会把这里的文件和 Core 一起放进安装包，使电脑不联网也能用。

```
desktop/vendor/
├── adb/
│   ├── windows-amd64/   adb.exe、AdbWinApi.dll、AdbWinUsbApi.dll（adb 33.0.3）+ 通用 C 运行库 43 个 DLL
│   ├── windows-386/     同上（adb 是 32 位程序，两个目录内容相同）
│   ├── linux-amd64/     adb（麒麟 x86_64）
│   ├── linux-arm64/     adb（麒麟 arm64，需自行编译，见 PLAN.md 5.1）
│   └── linux-loong64/   adb（麒麟龙芯，需自行编译）
└── app/
    └── p2d.apk          手机端安装包（mobile 构建产物）
```

运行 `bash scripts/fetch-vendor.sh` 会自动下载 adb 和 Windows 运行库到这里并核对 SHA-256（GitHub 构建也用它）；手机端安装包由 `scripts/build-apk.sh` 生成。Windows 版 adb 必须用 **33.0.3**：更新的版本用到了 Win8 / Win10 才有的系统函数，在 Win7 上启动失败或连接手机时崩溃（实测结果见 TESTING.md 1.5）。

### Windows 通用 C 运行库（UCRT）

adb 33.0.3 依赖通用 C 运行库。Win10 / 11 系统自带；Win7 要装过系统更新 KB2999226 才有，没打补丁的 Win7 会缺。
所以把运行库放在 adb.exe 旁边（微软支持的「随程序部署」方式）：Win7 上 adb 优先加载这里的副本，Win10 / 11 上系统会忽略它们、照常用系统自带的。

- 来源：微软官方 NuGet 包 `Microsoft.Windows.SDK.CPP` 10.0.19041.5 中的 `c/Redist/10.0.19041.0/ucrt/DLLs/x86/`，共 43 个文件（`ucrtbase.dll` 版本 10.0.19041.1），均有微软的有效数字签名。
  下载地址：https://api.nuget.org/v3-flatcontainer/microsoft.windows.sdk.cpp/10.0.19041.5/microsoft.windows.sdk.cpp.10.0.19041.5.nupkg
- 许可：Windows SDK 许可协议（https://aka.ms/WinSDKLicenseURL），`Redist` 目录下的 UCRT DLL 属于允许随软件分发的文件。
- 两个目录都放 x86 版本，因为 adb 本身是 32 位程序。
- 在 Win7 上实测过：adb 加载的 `ucrtbase.dll` 和 `api-ms-win-crt-*.dll` 都来自这个目录。
