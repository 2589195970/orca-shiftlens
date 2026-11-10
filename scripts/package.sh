#!/bin/sh
# 在独立目录准备源码安装包；悬浮窗由插件在用户机器构建。
set -eu
cd "$(dirname "$0")/.."
release_base=${TMPDIR:-/tmp}
release_dir=$(mktemp -d "${release_base%/}/shiftlens-source.XXXXXX")
mkdir -p "$release_dir/src"
cp orca-plugin.json README.md LICENSE "$release_dir/"
cp src/worker.ts src/engine.ts src/fuzzy.ts src/rg.ts src/native.ts "$release_dir/src/"
cp -R ui native assets "$release_dir/"
orca plugin validate "$release_dir" --json
tar -czf "$release_dir.tar.gz" -C "$release_dir" .
printf '\n插件目录：%s\n安装归档：%s.tar.gz\n' "$release_dir" "$release_dir"
