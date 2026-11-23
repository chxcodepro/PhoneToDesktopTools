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
PKG=phonetodesktop       # deb 包名
DEST=/opt/PhoneToDesktop # 安装位置

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
  local name="PhoneToDesktop-$VERSION-linux-$arch"
  local root="$WORK/deb-$arch"
  [ -x "$dir/$EXE" ] || { echo "找不到 $dir/$EXE" >&2; exit 1; }

  mkdir -p "$root$DEST" "$root/DEBIAN" "$root/usr/share/applications" "$root/usr/share/icons/hicolor/256x256/apps"
  cp -a "$dir/." "$root$DEST/"
  cp "$APP/build/icon.png" "$root/usr/share/icons/hicolor/256x256/apps/$PKG.png"
  cat > "$root/usr/share/applications/$PKG.desktop" <<DESKTOP
[Desktop Entry]
Name=PhoneToDesktop
Comment=用手机控制这台电脑
Exec=$DEST/$EXE %U
Icon=$PKG
Terminal=false
Type=Application
Categories=Utility;
StartupWMClass=PhoneToDesktop
DESKTOP
  # 版本号如 0.1.0-ci.12：dpkg 把「-」后面当作修订号，合法
  cat > "$root/DEBIAN/control" <<CONTROL
Package: $PKG
Version: $VERSION
Architecture: $arch
Maintainer: PhoneToDesktop
Installed-Size: $(du -sk "$root" | cut -f1)
Depends: libgtk-3-0, libnss3, libxss1, libxtst6, libasound2
Section: utils
Priority: optional
Description: PhoneToDesktop 电脑端
 用手机通过数据线或 WiFi 控制这台电脑。
CONTROL
  # Chromium 沙箱需要 setuid 的 chrome-sandbox（没有它 Electron 在部分系统上无法启动）
  cat > "$root/DEBIAN/postinst" <<'POSTINST'
#!/bin/sh
set -e
chmod 4755 /opt/PhoneToDesktop/chrome-sandbox || true
command -v update-desktop-database >/dev/null && update-desktop-database -q || true
POSTINST
  chmod 755 "$root/DEBIAN/postinst"
  dpkg-deb --root-owner-group -Zxz --build "$root" "$REL/$name.deb" >/dev/null
  tar -czf "$REL/$name.tar.gz" -C "$dir/.." --transform "s|^$(basename "$dir")|PhoneToDesktop|" "$(basename "$dir")"
  echo "✓ $name.deb / .tar.gz"
}

package "$REL/linux-unpacked" amd64
[ -d "$REL/linux-arm64-unpacked" ] && package "$REL/linux-arm64-unpacked" arm64
if assemble_loong64; then
  package "$WORK/linux-loong64-unpacked" loongarch64
fi
rm -rf "$WORK"
