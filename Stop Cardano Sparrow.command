#!/bin/zsh
set -euo pipefail

APP_DIR=${0:A:h}
PID_FILE="$APP_DIR/.runtime/server.pid"

if [[ ! -f "$PID_FILE" ]]; then
  echo "Cardano Sparrow 当前没有由启动脚本管理的运行实例。"
  exit 0
fi

SERVER_PID=$(<"$PID_FILE")
if [[ "$SERVER_PID" != <-> ]] || ! kill -0 "$SERVER_PID" 2>/dev/null; then
  rm -f "$PID_FILE"
  echo "服务已经停止，已清理过期状态。"
  exit 0
fi

COMMAND=$(ps -p "$SERVER_PID" -o command= 2>/dev/null || true)
if [[ "$COMMAND" != *"$APP_DIR/node_modules/vite/bin/vite.js preview"* ]]; then
  echo "PID $SERVER_PID 已被其他进程占用。为避免误杀，未执行停止操作。"
  exit 1
fi

kill -TERM "$SERVER_PID"
for _ in {1..20}; do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    rm -f "$PID_FILE"
    echo "Cardano Sparrow 已安全停止。"
    exit 0
  fi
  sleep 0.25
done

echo "服务未在 5 秒内退出，请稍后再次运行停止脚本。"
exit 1
