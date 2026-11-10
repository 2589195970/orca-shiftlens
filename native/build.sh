#!/bin/sh
# 编译悬浮窗外壳到 bin/search-panel（本机架构）。
set -e
cd "$(dirname "$0")/.."
mkdir -p bin
swiftc -O -swift-version 5 native/main.swift -o bin/search-panel
codesign --force --sign - bin/search-panel
echo "bin/search-panel"
