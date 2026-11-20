# 虚拟机 / 实机测试说明

用虚拟机测试 Win7 和银河麒麟（苹果系列除外）。手机要通过虚拟机的 **USB 直通** 连进虚拟机（VirtualBox 需要安装同版本的 Extension Pack，在「设备 → USB」里勾选手机；VMware 在「虚拟机 → 可移动设备」里连接）。

> 下面的网址请在能上网的电脑上下载，再拷进虚拟机。目标电脑本身不需要联网。

## 1. Windows 7 虚拟机

### 1.1 需要下载的文件

| 文件 | 网址 | 用途 |
|---|---|---|
| SHA-2 签名补丁 KB4474419 | https://www.catalog.update.microsoft.com/Search.aspx?q=KB4474419 | 没打这个补丁的 Win7 装不上新签名的驱动 |
| 服务堆栈更新 KB4490628 | https://www.catalog.update.microsoft.com/Search.aspx?q=KB4490628 | 安装上一个补丁的前置条件 |
| adb（最新版） | https://dl.google.com/android/repository/platform-tools-latest-windows.zip | 先试最新版。37.x 的 adb.exe 是 32 位程序，PE 头标记的最低系统为 Vista，32/64 位 Win7 都可能直接运行 |
| adb（较旧版本，备用） | https://dl.google.com/android/repository/platform-tools_r33.0.3-windows.zip<br>https://dl.google.com/android/repository/platform-tools_r31.0.3-windows.zip | 最新版在 Win7 上运行不了时依次换旧版本试 |
| Google USB 驱动 | https://dl.google.com/android/repository/usb_driver_r13-windows.zip | Win7 不会自动安装 ADB 驱动 |
| 小米手机驱动（如用小米手机） | 小米官网或「小米手机助手」安装包中的 USB 驱动 | Google 驱动不认非 Google 品牌手机时使用 |

补丁选择与虚拟机位数一致的版本（x64 或 x86）。

### 1.2 存放位置

在虚拟机里建一个文件夹，例如 `C:\p2d-test\`：

```
C:\p2d-test\
├── p2d-core.exe            ← 仓库 dist\core\windows-amd64\（32 位系统用 windows-386\）
└── vendor\
    ├── adb\                ← 解压 platform-tools 后，把其中的 adb.exe、AdbWinApi.dll、AdbWinUsbApi.dll 放这里
    └── app\
        └── p2d.apk         ← 手机端安装包（构建产物，见 docs/DEV.md）
```

### 1.3 测试步骤

1. 先装 KB4490628，重启；再装 KB4474419，重启。
2. 手机插上并直通到虚拟机，在设备管理器里给「Android」设备安装驱动（手动指定 USB 驱动解压后的目录）。
3. 双击运行 `p2d-core.exe`（会出现一个命令行窗口，显示运行日志）。
4. 看日志：
   - `发现设备 …（状态 unauthorized）`：在手机上点「允许 USB 调试」。
   - `正在安装 …`：部分手机需要在手机上确认安装。
   - `已启动手机端，等待连接` → `手机已连接`：说明自动连接成功。
5. 在手机上让 Agent 截图、读写文件、执行命令，并试试远程桌面。
6. 也可以测电脑端界面：仓库 `desktop/app/release/win-unpacked/` 整个文件夹拷进去，运行 `PhoneToDesktop.exe`（目前只打了 64 位）。把 adb 和 apk 放到 `resources\core\vendor\` 下，结构与上面一致。
7. 需要记录的结果：
   - adb 哪个版本能在 Win7 上运行；
   - 驱动是否安装成功；
   - 截图、键鼠在 Win7 上是否正常；
   - 界面红框在开启和关闭 Aero 两种情况下是否正常。

### 1.4 打包进安装包

确定能用的 adb 版本后，放到仓库 `desktop/vendor/adb/windows-amd64/` 和 `windows-386/`，手机端 APK 放到 `desktop/vendor/app/p2d.apk`，再运行 `npm run dist:win64`，它们会被一起打进便携版（见 desktop/vendor/README.md）。

## 2. 银河麒麟虚拟机（x86_64）

> arm64 版麒麟需要 ARM 电脑或 QEMU 模拟（很慢），建议优先在 x86_64 虚拟机上测试，arm64 等有实机再测。

### 2.1 需要下载的文件

| 文件 | 网址 |
|---|---|
| 银河麒麟桌面版 V10 安装镜像 | 麒麟软件官网 https://www.kylinos.cn/ （需要注册申请试用版） |
| adb（Linux 版） | https://dl.google.com/android/repository/platform-tools-latest-linux.zip |

### 2.2 存放位置

```
~/p2d-test/
├── p2d-core                ← 仓库 dist/core/linux-amd64/p2d-core
└── vendor/
    ├── adb/adb             ← platform-tools 中的 adb
    └── app/p2d.apk
```

### 2.3 测试步骤

1. 登录时选择 X11（Xorg）会话。Wayland 会话下截图和键鼠暂不支持。
2. 允许普通用户访问手机（只需做一次，需要输入密码）：

   ```bash
   echo 'SUBSYSTEM=="usb", ATTR{idVendor}=="2717", MODE="0666"' | sudo tee /etc/udev/rules.d/51-android.rules
   sudo udevadm control --reload-rules
   ```

   `2717` 是小米的厂商 ID，其他品牌用 `lsusb` 查看手机那一行 `ID xxxx:yyyy` 中的 `xxxx`。

3. 运行：

   ```bash
   cd ~/p2d-test && chmod +x p2d-core vendor/adb/adb && ./p2d-core
   ```

4. 如果麒麟安全中心提示「未授权的程序」，在「安全中心 → 应用执行控制」里允许 `p2d-core` 和 `adb`。
5. 其余步骤与 Win7 相同。重点记录：
   - 截图是否正常（X11）；
   - 键盘输入中文是否正常；
   - 回收站删除后，在文件管理器里能否看到并还原。
