#!/usr/bin/env bash
# 构建手机端 release APK，输出到 dist/app/p2d.apk，并复制到 desktop/vendor/app/p2d.apk（供电脑端自动安装）。
#
# Windows 下 C++ 组件（react-native-worklets 等）的编译路径很容易超过 260 字符，
# 所以先把 mobile/ 同步到一个短路径（默认 D:\p2dm）再构建。
#
# 用法：scripts/build-apk.sh [架构，默认 arm64-v8a,armeabi-v7a]
# 可选环境变量：P2D_BUILD_DIR（短路径目录）、P2D_PROXY（如 127.0.0.1:1159，Gradle 下载依赖时使用）、
#               P2D_OFFLINE=1（离线构建，列出缺失的依赖）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ARCHS="${1:-arm64-v8a,armeabi-v7a}"
SRC="$ROOT/mobile"
BUILD="${P2D_BUILD_DIR:-/d/p2dm}"

if [ ! -d "$SRC/android" ]; then
  echo "先生成原生工程：cd mobile && npx expo prebuild --platform android --no-install" >&2
  exit 1
fi

echo "同步 mobile/ → $BUILD …"
mkdir -p "$BUILD"
# robocopy 返回值 < 8 都表示成功
MSYS_NO_PATHCONV=1 robocopy "$(cygpath -w "$SRC")" "$(cygpath -w "$BUILD")" /MIR /NFL /NDL /NJH /NJS /NP \
  /XD "$(cygpath -w "$SRC/android/app/build")" "$(cygpath -w "$SRC/android/build")" "$(cygpath -w "$SRC/android/.gradle")" \
      "$(cygpath -w "$SRC/android/app/.cxx")" "$(cygpath -w "$SRC/.expo")" \
  /XD .cxx || [ $? -lt 8 ]

SDK="${ANDROID_HOME:-${LOCALAPPDATA:-}/Android/Sdk}"
printf 'sdk.dir=%s\n' "$(cygpath -m "$SDK")" > "$BUILD/android/local.properties"

# CMake 3.22.1 自带的 ninja 1.10 不支持 Windows 长路径，编译 C++ 组件时会报 mkdir 失败。
# 使用 SDK 里最新的 CMake 3.x（3.31.6 带 ninja 1.12.1，支持长路径；还需系统已开启 LongPathsEnabled）。
# 安装：https://dl.google.com/android/repository/cmake-3.31.6-windows.zip 解压到 <SDK>/cmake/3.31.6/
CMAKE_DIR="$(ls -d "$SDK"/cmake/3.* 2>/dev/null | sort -V | tail -1 || true)"
if [ -n "$CMAKE_DIR" ]; then
  echo "使用 CMake：$CMAKE_DIR"
  printf 'cmake.dir=%s\n' "$(cygpath -m "$CMAKE_DIR")" >> "$BUILD/android/local.properties"
fi

if [ -n "${P2D_PROXY:-}" ]; then
  host="${P2D_PROXY%:*}"; port="${P2D_PROXY#*:}"
  export JAVA_TOOL_OPTIONS="-Dhttps.proxyHost=$host -Dhttps.proxyPort=$port -Dhttp.proxyHost=$host -Dhttp.proxyPort=$port -Dhttp.nonProxyHosts=localhost|127.0.0.1"
fi

# 下载不了的依赖可以手动放到 ~/.m2/repository（见 scripts/gradle-local-repo.gradle）
GRADLE_ARGS=(--init-script "$(cygpath -m "$ROOT/scripts/gradle-local-repo.gradle")" --console=plain)
# P2D_OFFLINE=1：不联网，只用缓存和本机仓库（加 --continue 可一次列出所有缺失的依赖）
[ -n "${P2D_OFFLINE:-}" ] && GRADLE_ARGS+=(--offline --continue)

cd "$BUILD/android"
./gradlew assembleRelease -PreactNativeArchitectures="$ARCHS" "${GRADLE_ARGS[@]}"

APK="$BUILD/android/app/build/outputs/apk/release/app-release.apk"
mkdir -p "$ROOT/dist/app" "$ROOT/desktop/vendor/app"
cp "$APK" "$ROOT/dist/app/p2d.apk"
cp "$APK" "$ROOT/desktop/vendor/app/p2d.apk"
echo "✓ dist/app/p2d.apk（$(du -h "$APK" | cut -f1)），已复制到 desktop/vendor/app/"
