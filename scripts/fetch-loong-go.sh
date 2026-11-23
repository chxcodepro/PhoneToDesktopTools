#!/usr/bin/env bash
# 下载龙芯官方的旧世界（ABI1.0）Go 1.20，用来编译麒麟 V10 龙芯版的电脑端核心（见 build-core.sh 开头的说明）。
# 只能在 x86_64 Linux 上运行（龙芯只提供 linux-amd64 的交叉编译版）。
# 用法：eval "$(bash scripts/fetch-loong-go.sh [目录])"   之后 GO_LOONG_OW 就指向它
set -euo pipefail

DIR="${1:-${RUNNER_TEMP:-/tmp}/go-loong-ow}"
URL=https://ftp.loongnix.cn/toolchain/golang/go-1.20/abi1.0/go1.20.12.linux-amd64.tar.gz
SHA=115c83d92a759b052ed1ac5f48a0a5b968ca40f65473752d0981280144766389

if [ ! -x "$DIR/go/bin/go" ]; then
  mkdir -p "$DIR"
  curl -fsSL --retry 3 -o "$DIR/go.tgz" "$URL" >&2
  echo "$SHA  $DIR/go.tgz" | sha256sum -c - >&2
  tar -xzf "$DIR/go.tgz" -C "$DIR"
  rm "$DIR/go.tgz"
fi
# 确认确实是旧世界版本：运行时的 ucontext 里有旧世界特有的 24 字节填充
grep -Eq '_pad0[[:space:]]+\[24\]byte' "$DIR/go/src/runtime/defs_linux_loong64.go" || { echo "不是龙芯旧世界的 Go" >&2; exit 1; }
echo "export GO_LOONG_OW=$DIR/go/bin/go"
