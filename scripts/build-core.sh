#!/usr/bin/env bash
# 交叉编译电脑端核心服务，输出到 dist/core/<系统>-<架构>/
# 用法：scripts/build-core.sh [版本号]
# 需要 Go 1.20.x（最后一个支持 Windows 7 的版本），默认使用项目内 .tools/go
#
# 龙芯：麒麟 V10 的 LoongArch 版是「旧世界」（ABI1.0，内核 4.19），信号处理用的 ucontext 结构和信号集大小
# 都和上游 Go 假设的「新世界」不同，上游 Go 编出的程序在上面一收到信号就出错。
# 设置 GO_LOONG_OW 为龙芯官方的旧世界 Go（https://ftp.loongnix.cn/toolchain/golang/go-1.20/abi1.0/，
# 只有 linux-amd64 版，用 scripts/fetch-loong-go.sh 下载）后才编译龙芯版；没设置时跳过，不产出错误的程序。
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
  linux/loong64   # 麒麟 loongarch64（龙芯 3A5000/3A6000，旧世界）
)
# 不支持：龙芯 3A4000（mips64el，没有可用的 Electron 22）、申威（sw64，Go 官方不支持）

cd "$ROOT/desktop/core"
export CGO_ENABLED=0 GOTOOLCHAIN=local
for t in "${TARGETS[@]}"; do
  os="${t%/*}"; arch="${t#*/}"
  out="$ROOT/dist/core/$os-$arch"
  ext=""; [ "$os" = windows ] && ext=".exe"
  go="$GO"
  if [ "$arch" = loong64 ]; then
    if [ -z "${GO_LOONG_OW:-}" ]; then
      echo "- $t 跳过：没有设置 GO_LOONG_OW（龙芯旧世界 Go），见脚本开头的说明" >&2
      rm -rf "$out"
      continue
    fi
    go="$GO_LOONG_OW"
  fi
  mkdir -p "$out"
  GOOS="$os" GOARCH="$arch" "$go" build -trimpath \
    -ldflags "-s -w -X p2d/core/internal/server.Version=$VERSION" \
    -o "$out/p2d-core$ext" ./cmd/p2d-core
  echo "✓ $t → dist/core/$os-$arch/p2d-core$ext"
done
