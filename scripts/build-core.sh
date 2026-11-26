#!/usr/bin/env bash
# 交叉编译电脑端核心服务，输出到 dist/core/<系统>-<架构>/
# 用法：scripts/build-core.sh [版本号]
# 需要 Go 1.20.x（最后一个支持 Windows 7 的版本），默认使用项目内 .tools/go
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${1:-0.1.0-dev}"
GO="${GO:-$ROOT/.tools/go/bin/go}"
if [ ! -x "$GO" ] && [ ! -x "$GO.exe" ]; then GO=go; fi

GOVER="$("$GO" env GOVERSION)"
case "$GOVER" in
  go1.20*) ;;
  *) echo "警告：当前是 $GOVER，Windows 7 需要用 Go 1.20.x 编译" >&2 ;;
esac

TARGETS=(
  windows/amd64   # Win7/10/11 64 位
  windows/386     # Win7 32 位
  linux/amd64     # 麒麟 x86_64（兆芯、海光）
  linux/arm64     # 麒麟 arm64（飞腾、鲲鹏、海思麒麟）
)
# 不提供：龙芯（麒麟 V10 的龙芯版是旧世界 ABI，要用龙芯官方的 Go 和 Electron，2026年11月起不再做）、
# 申威（sw64，Go 官方不支持）
#
# Mac：截图、键鼠、USB 要调用系统框架（cgo），只能在 Mac 上用 Xcode 的 clang 编译，所以在 Mac 上运行本脚本时
# 只编 Mac 的两个版本（Intel、Apple 芯片），其他平台在 Linux / Windows 上交叉编译。最低支持 macOS 10.13（Go 1.20 的下限）。
if [ "$(uname -s)" = Darwin ]; then
  TARGETS=(darwin/amd64 darwin/arm64)
fi

cd "$ROOT/desktop/core"
export CGO_ENABLED=0 GOTOOLCHAIN=local
for t in "${TARGETS[@]}"; do
  os="${t%/*}"; arch="${t#*/}"
  out="$ROOT/dist/core/$os-$arch"
  ext=""; [ "$os" = windows ] && ext=".exe"
  mkdir -p "$out"
  cgo=0; cc=""
  if [ "$os" = darwin ]; then
    cgo=1
    case "$arch" in amd64) cc="clang -arch x86_64" ;; arm64) cc="clang -arch arm64" ;; esac
  fi
  CGO_ENABLED="$cgo" CC="$cc" MACOSX_DEPLOYMENT_TARGET=10.13 GOOS="$os" GOARCH="$arch" "$GO" build -trimpath \
    -ldflags "-s -w -X p2d/core/internal/server.Version=$VERSION" \
    -o "$out/p2d-core$ext" ./cmd/p2d-core
  echo "✓ $t → dist/core/$os-$arch/p2d-core$ext"
done
