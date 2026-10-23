#!/bin/bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
app="$root/src-tauri/target/release/bundle/macos/OpenApi.app"

if [[ ! -d "$app" ]]; then
  echo "还没有打包产物，先执行 npm run tauri build" >&2
  exit 1
fi

pids="$(ps -ax -o pid=,command= | awk '/\/OpenApi\.app\/Contents\/MacOS\/openapi$/ { print $1 }')"
if [[ -n "$pids" ]]; then
  echo "结束已有进程: $pids"
  kill $pids || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    left="$(ps -ax -o pid=,command= | awk '/\/OpenApi\.app\/Contents\/MacOS\/openapi$/ { print $1 }')"
    [[ -z "$left" ]] && break
    sleep 0.3
  done
  left="$(ps -ax -o pid=,command= | awk '/\/OpenApi\.app\/Contents\/MacOS\/openapi$/ { print $1 }')"
  if [[ -n "$left" ]]; then
    kill -9 $left || true
  fi
fi

rm -rf /Applications/OpenApi.app
cp -R "$app" /Applications/OpenApi.app
xattr -cr /Applications/OpenApi.app
open /Applications/OpenApi.app
echo "已安装并启动"
