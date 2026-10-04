#!/usr/bin/env bash
# 一条命令跑完 AI 视角验收：起服务 → 测评 → 关服务。
# 前提：Node 22.5 或更高（用到内置的 node:sqlite）。零 npm 依赖，不需要 install。
#
#   bash EVAL-PACKAGE/run-eval.sh
#
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
cd "$ROOT" || { echo "找不到项目根目录"; exit 1; }

if [ ! -f server.js ]; then
  echo "[x] 这里没有 server.js。"
  echo "    请把**整个项目目录**（不只是 EVAL-PACKAGE/）一起提供 ——"
  echo "    EVAL-PACKAGE 是文档与快照，可执行的部分在上一层。"
  exit 1
fi

NODE_BIN="${NODE:-node}"
command -v "$NODE_BIN" >/dev/null 2>&1 || { echo "[x] 找不到 node。请装 Node 22.5+ 后重试。"; exit 1; }

VER="$("$NODE_BIN" --version)"
echo "node $VER"
case "$VER" in
  v1[0-9].*|v2[0-1].*|v22.[0-4].*)
    echo "[x] 这个版本太低（需要 >= 22.5，因为用了内置 node:sqlite）。当前 $VER"; exit 1;;
esac

PORT="${PORT:-8787}"
echo "起服务（:$PORT，输出丢弃）…"
"$NODE_BIN" --no-warnings server.js >/dev/null 2>&1 &
SRV=$!
trap 'kill "$SRV" >/dev/null 2>&1' EXIT

ok=0
for i in $(seq 1 80); do
  if "$NODE_BIN" -e "fetch('http://127.0.0.1:$PORT/v1/health').then(()=>process.exit(0)).catch(()=>process.exit(1))" >/dev/null 2>&1; then ok=1; break; fi
  sleep 0.3
done
[ "$ok" = 1 ] || { echo "[x] 服务 24 秒内没起来。手动跑 node server.js 看报错。"; exit 1; }

echo ""
"$NODE_BIN" --no-warnings agent-trial.mjs --base "http://127.0.0.1:$PORT"
RC=$?

echo ""
echo "------------------------------------------------------------"
echo "服务已关闭。想自己动手探索，另开一个终端跑： node server.js"
echo "然后就能 curl 了，比如："
echo "  curl -H 'Accept: application/json' http://127.0.0.1:$PORT/"
echo "  curl http://127.0.0.1:$PORT/v1/openapi.json | head -60"
echo "------------------------------------------------------------"
exit $RC
