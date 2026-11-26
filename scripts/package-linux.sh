#!/usr/bin/env bash
# 把 electron-builder 打出的 linux-*-unpacked 目录做成麒麟常用的 .deb 和 .tar.gz，并拼装龙芯版。
# 需要先在 desktop/app 里运行 npm run dist:linux（产出 release/linux-unpacked、release/linux-arm64-unpacked、core-bin/）。
#
# 用法：scripts/package-linux.sh <版本号>
#   x64、arm64：直接用 electron-builder 的目录
#   龙芯（loongarch64）：electron-builder 不支持这个架构。用龙芯官方的 Electron 22.3.27（旧世界）替换掉 x64 目录里的
#   Electron 运行时，应用代码（resources/app.asar）原样复用，核心换成 core-bin/linux-loong64（需要 build-core.sh 编出龙芯版）
set -euo pipefail

VERSION="${1:?用法：$0 <版本号>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/desktop/app"
REL="$APP/release"
WORK="${P2D_PKG_WORK:-$REL/pkg-work}"
EXE=p2d-desktop          # electron-builder 的可执行文件名（package.json 的 name）
PKG=p2d                  # deb 包名
OLD_PKG=phonetodesktop   # 改名前的包名：新包声明替换它，安装时 dpkg 会自动卸掉旧包（配置在 ~/.config 里，由程序自己搬迁）
DEST=/opt/p2d            # 安装位置（改名前是 /opt/PhoneToDesktop）

LOONG_ELECTRON_URL=https://ftp.loongnix.cn/electron/LoongArch/v22.3.27/electron-v22.3.27-linux-loong64.zip
LOONG_ELECTRON_SHA=4b46329143bdfb34c11c10c4163b8bd85a3ff4506dd117c8838e479019563a53

rm -rf "$WORK"
mkdir -p "$WORK"

# 龙芯版：在 x64 目录的基础上换掉 Electron 运行时和核心
assemble_loong64() {
  local x64="$REL/linux-unpacked" out="$WORK/linux-loong64-unpacked" zip="$WORK/electron-loong64.zip"
  if [ ! -d "$APP/core-bin/linux-loong64" ]; then
    echo "- 龙芯版跳过：没有 core-bin/linux-loong64（build-core.sh 没有设置 GO_LOONG_OW）" >&2
    return 1
  fi
  curl -fsSL --retry 3 -o "$zip" "${P2D_LOONG_ELECTRON_ZIP_URL:-$LOONG_ELECTRON_URL}"
  echo "$LOONG_ELECTRON_SHA  $zip" | sha256sum -c - >&2
  mkdir -p "$out"
  unzip -q "$zip" -d "$out"
  rm -f "$zip" "$out/resources/default_app.asar"
  mv "$out/electron" "$out/$EXE"
  cp "$x64/resources/app.asar" "$out/resources/"
  cp -r "$x64/resources/icons" "$out/resources/"
  cp -r "$APP/core-bin/linux-loong64" "$out/resources/core"
  chmod 755 "$out/$EXE" "$out/resources/core/p2d-core"
}

# 一个架构的目录 → .deb + .tar.gz
package() {
  local dir="$1" arch="$2" # arch 用 Debian 的架构名：amd64 / arm64 / loongarch64
  local name="P2D-$VERSION-linux-$arch"
  local root="$WORK/deb-$arch"
  [ -x "$dir/$EXE" ] || { echo "找不到 $dir/$EXE" >&2; exit 1; }

  mkdir -p "$root$DEST" "$root/DEBIAN" "$root/usr/share/applications" "$root/usr/share/icons/hicolor/256x256/apps" "$root/lib/udev/rules.d"
  cp -a "$dir/." "$root$DEST/"
  cp "$APP/build/icon.png" "$root/usr/share/icons/hicolor/256x256/apps/$PKG.png"
  cat > "$root/usr/share/applications/$PKG.desktop" <<DESKTOP
[Desktop Entry]
Name=P2D
Comment=用手机控制这台电脑
Exec=$DEST/$EXE %U
Icon=$PKG
Terminal=false
Type=Application
Categories=Utility;
StartupWMClass=P2D
DESKTOP
  # 免调试连接（AOA）：电脑端以普通用户身份运行，要能打开安卓手机的 USB 设备节点（/dev/bus/usb/…）。
  # uaccess 让当前登录桌面的用户获得访问权限（systemd-logind 设置 ACL），规则文件名要排在 73-seat-late 之前。
  cat > "$root/lib/udev/rules.d/70-p2d.rules" <<'UDEV'
# P2D 免调试连接（Android 配件模式）：让登录桌面的用户能访问安卓手机的 USB 设备
SUBSYSTEM!="usb", GOTO="p2d_end"
ENV{DEVTYPE}!="usb_device", GOTO="p2d_end"
ENV{ID_USB_INTERFACES}=="", IMPORT{builtin}="usb_id"
# 没开 USB 调试的手机（MTP 接口）、开了调试的手机（ADB 接口）：电脑端发请求让它切换到配件模式
ENV{ID_USB_INTERFACES}=="*:060101:*", TAG+="uaccess"
ENV{ID_USB_INTERFACES}=="*:ff4201:*", TAG+="uaccess"
# 切换后的配件设备（Google 统一的 18D1:2D00～2D05）
ATTR{idVendor}=="18d1", ATTR{idProduct}=="2d0[0-5]", TAG+="uaccess", MODE="0666"
LABEL="p2d_end"
UDEV
  # 版本号如 0.1.0-ci.12：dpkg 把「-」后面当作修订号，合法
  cat > "$root/DEBIAN/control" <<CONTROL
Package: $PKG
Version: $VERSION
Architecture: $arch
Maintainer: P2D
Installed-Size: $(du -sk "$root" | cut -f1)
Depends: libgtk-3-0, libnss3, libxss1, libxtst6, libasound2
Conflicts: $OLD_PKG
Replaces: $OLD_PKG
Provides: $OLD_PKG
Section: utils
Priority: optional
Description: P2D 电脑端
 用手机通过数据线或 WiFi 控制这台电脑。
CONTROL
  # 安装后：Chromium 沙箱需要 setuid 的 chrome-sandbox（没有它 Electron 在部分系统上无法启动）；
  # 和 WPS 一样把图标放到每个用户的桌面（麒麟用户习惯从桌面打开）以及新用户的桌面模板 /etc/skel/桌面；
  # 重新加载 udev 规则，已经插着的手机也立即生效
  cat > "$root/DEBIAN/postinst" <<'POSTINST'
#!/bin/sh
set -e
chmod 4755 /opt/p2d/chrome-sandbox || true
command -v update-desktop-database >/dev/null && update-desktop-database -q || true
. /opt/p2d/desktop-dirs.sh
for_each_desktop place || true
if command -v udevadm >/dev/null; then
  udevadm control --reload-rules || true
  udevadm trigger --subsystem-match=usb --action=change || true
fi
POSTINST
  cat > "$root/DEBIAN/postrm" <<'POSTRM'
#!/bin/sh
set -e
if [ "$1" = remove ] || [ "$1" = purge ]; then
  # 程序目录此时已删除，desktop-dirs.sh 不在了，这里单独写一遍查找桌面目录的逻辑
  for h in /root /home/*; do
    [ -d "$h" ] || continue
    for d in "$h/桌面" "$h/Desktop"; do rm -f "$d/p2d.desktop"; done
    f="$h/.config/user-dirs.dirs"
    if [ -f "$f" ]; then
      d=$(sed -n 's/^XDG_DESKTOP_DIR="\(.*\)"$/\1/p' "$f" | sed "s|\$HOME|$h|")
      [ -n "$d" ] && rm -f "$d/p2d.desktop"
    fi
  done
  rm -f /etc/skel/桌面/p2d.desktop /etc/skel/Desktop/p2d.desktop
  command -v udevadm >/dev/null && udevadm control --reload-rules || true
fi
POSTRM
  # 查找每个用户的桌面目录（user-dirs.dirs 里的 XDG_DESKTOP_DIR，没有时用「桌面」或「Desktop」）
  cat > "$root$DEST/desktop-dirs.sh" <<'DIRS'
# 由 postinst 调用：for_each_desktop place
SRC=/usr/share/applications/p2d.desktop
place() { # place <桌面目录> <属主>
  [ -d "$1" ] || return 0
  cp "$SRC" "$1/p2d.desktop"
  chown "$2" "$1/p2d.desktop" 2>/dev/null || true
  chmod 755 "$1/p2d.desktop"
}
for_each_desktop() {
  for h in /root /home/*; do
    [ -d "$h" ] || continue
    u=$(stat -c %U "$h")
    d=""
    f="$h/.config/user-dirs.dirs"
    [ -f "$f" ] && d=$(sed -n 's/^XDG_DESKTOP_DIR="\(.*\)"$/\1/p' "$f" | sed "s|\$HOME|$h|")
    if [ -z "$d" ] || [ ! -d "$d" ]; then
      if [ -d "$h/桌面" ]; then d="$h/桌面"; else d="$h/Desktop"; fi
    fi
    "$1" "$d" "$u"
  done
  for d in /etc/skel/桌面 /etc/skel/Desktop; do "$1" "$d" root; done
}
DIRS
  chmod 755 "$root/DEBIAN/postinst" "$root/DEBIAN/postrm"
  dpkg-deb --root-owner-group -Zxz --build "$root" "$REL/$name.deb" >/dev/null
  tar -czf "$REL/$name.tar.gz" -C "$dir/.." --transform "s|^$(basename "$dir")|p2d|" "$(basename "$dir")"
  echo "✓ $name.deb / .tar.gz"
}

package "$REL/linux-unpacked" amd64
[ -d "$REL/linux-arm64-unpacked" ] && package "$REL/linux-arm64-unpacked" arm64
if assemble_loong64; then
  package "$WORK/linux-loong64-unpacked" loongarch64
fi
rm -rf "$WORK"
