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
  linux/arm64     # 麒麟 arm64（飞腾、鲲鹏）
  linux/loong64   # 麒麟 loongarch64（龙芯）
)

cd "$ROOT/desktop/core"
export CGO_ENABLED=0 GOTOOLCHAIN=local
for t in "${TARGETS[@]}"; do
  os="${t%/*}"; arch="${t#*/}"
  out="$ROOT/dist/core/$os-$arch"
  ext=""; [ "$os" = windows ] && ext=".exe"
  mkdir -p "$out"
  GOOS="$os" GOARCH="$arch" "$GO" build -trimpath \
    -ldflags "-s -w -X p2d/core/internal/server.Version=$VERSION" \
    -o "$out/p2d-core$ext" ./cmd/p2d-core
  echo "✓ $t → dist/core/$os-$arch/p2d-core$ext"
done
