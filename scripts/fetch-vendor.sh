#!/usr/bin/env bash
# 下载打包电脑端需要的第三方文件到 desktop/vendor/（这些文件不入库，见 desktop/vendor/README.md）：
#   - adb 33.0.3（Windows 能在 Win7 上用的最新版本；Linux x86_64 用同一版本）
#   - Windows 通用 C 运行库（UCRT，x86），放在 adb 旁边，没打 KB2999226 的 Win7 也能运行 adb
# 每个文件都核对 SHA-256，对不上就失败退出。
# 手机端安装包 desktop/vendor/app/p2d.apk 由 scripts/build-apk.sh 或 CI 生成，不在这里下载。
#
# 用法：scripts/fetch-vendor.sh
# 需要：curl、unzip、sha256sum
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENDOR="${P2D_VENDOR_DIR:-$ROOT/desktop/vendor}"  # P2D_VENDOR_DIR：放到别的目录（测试用）
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

ADB_VERSION=33.0.3
ADB_WIN_SHA=1e59afd40a74c5c0eab0a9fad3f0faf8a674267106e0b19921be9f67081808c2
ADB_LINUX_SHA=ab885c20f1a9cb528eb145b9208f53540efa3d26258ac3ce4363570a0846f8f7
# Windows SDK 10.0.19041（Win7 仍受支持时发布的版本）里的 UCRT 可再发行文件，许可见 desktop/vendor/README.md
UCRT_PKG=microsoft.windows.sdk.cpp
UCRT_PKG_VERSION=10.0.19041.5
UCRT_DIR="c/Redist/10.0.19041.0/ucrt/DLLs/x86"

fetch() { # fetch <url> <输出文件> [sha256]
  echo "下载 $1"
  curl -fsSL --retry 3 -o "$2" "$1"
  if [ -n "${3:-}" ]; then
    echo "$3  $2" | sha256sum -c --quiet - || { echo "校验失败：$1" >&2; exit 1; }
  fi
}

# adb（Windows）
fetch "https://dl.google.com/android/repository/platform-tools_r${ADB_VERSION}-windows.zip" "$TMP/adb-win.zip" "$ADB_WIN_SHA"
unzip -q -o "$TMP/adb-win.zip" -d "$TMP/win"
for arch in windows-amd64 windows-386; do # adb 是 32 位程序，两个目录内容相同
  mkdir -p "$VENDOR/adb/$arch"
  cp "$TMP/win/platform-tools/"{adb.exe,AdbWinApi.dll,AdbWinUsbApi.dll} "$VENDOR/adb/$arch/"
done

# UCRT（只取 x86 目录，逐个文件核对）
fetch "https://api.nuget.org/v3-flatcontainer/$UCRT_PKG/$UCRT_PKG_VERSION/$UCRT_PKG.$UCRT_PKG_VERSION.nupkg" "$TMP/sdk.nupkg"
unzip -q -o -j "$TMP/sdk.nupkg" "$UCRT_DIR/*" -d "$TMP/ucrt"
(cd "$TMP/ucrt" && sha256sum -c --quiet "$ROOT/scripts/ucrt-x86.sha256") || { echo "UCRT 文件校验失败" >&2; exit 1; }
n=$(ls "$TMP/ucrt" | wc -l)
[ "$n" -eq "$(wc -l < "$ROOT/scripts/ucrt-x86.sha256")" ] || { echo "UCRT 文件数量不对：$n" >&2; exit 1; }
for arch in windows-amd64 windows-386; do
  cp "$TMP/ucrt/"*.dll "$VENDOR/adb/$arch/"
done

# adb（Linux x86_64）。arm64 / 龙芯版 Google 不提供，需要自行编译（见 docs/PLAN.md 5.1）
fetch "https://dl.google.com/android/repository/platform-tools_r${ADB_VERSION}-linux.zip" "$TMP/adb-linux.zip" "$ADB_LINUX_SHA"
unzip -q -o "$TMP/adb-linux.zip" -d "$TMP/linux"
mkdir -p "$VENDOR/adb/linux-amd64"
cp "$TMP/linux/platform-tools/adb" "$VENDOR/adb/linux-amd64/adb"
chmod +x "$VENDOR/adb/linux-amd64/adb"

echo "✓ desktop/vendor/adb：Windows adb $ADB_VERSION + UCRT（$n 个文件），Linux x86_64 adb $ADB_VERSION"
