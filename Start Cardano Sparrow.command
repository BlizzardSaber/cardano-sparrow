#!/bin/zsh
set -euo pipefail

umask 077
APP_DIR=${0:A:h}
RUNTIME_DIR="$APP_DIR/.runtime"
PID_FILE="$RUNTIME_DIR/server.pid"
LOG_FILE="$RUNTIME_DIR/server.log"
URL="http://127.0.0.1:4173/"

mkdir -p "$RUNTIME_DIR"
cd "$APP_DIR"

if [[ -f "$PID_FILE" ]]; then
  RUNNING_PID=$(<"$PID_FILE")
  if [[ "$RUNNING_PID" == <-> ]] && kill -0 "$RUNNING_PID" 2>/dev/null; then
    echo "Cardano Sparrow 已在运行（PID $RUNNING_PID）。"
    [[ "${CARDANO_SPARROW_NO_OPEN:-0}" == "1" ]] || open "$URL"
    exit 0
  fi
  rm -f "$PID_FILE"
fi

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "未找到 Node.js。请先安装 Node.js 20.19+ 或 22.12+。"
  read "?按回车关闭……"
  exit 1
fi

if [[ ! -d node_modules ]]; then
  echo "首次运行，正在安装锁定版本的依赖……"
  npm ci
fi

echo "正在检查并构建应用……"
npm run build

if lsof -nP -iTCP:4173 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "端口 4173 已被其他程序占用，服务未启动。"
  read "?按回车关闭……"
  exit 1
fi

nohup node "$APP_DIR/node_modules/vite/bin/vite.js" preview --host 127.0.0.1 --port 4173 --strictPort >"$LOG_FILE" 2>&1 &
SERVER_PID=$!
print -r -- "$SERVER_PID" >"$PID_FILE"

for _ in {1..40}; do
  if curl --silent --fail --max-time 1 "$URL" >/dev/null 2>&1; then
    echo "Cardano Sparrow 已启动：$URL"
    echo "需要停止时，双击 Stop Cardano Sparrow.command。"
    [[ "${CARDANO_SPARROW_NO_OPEN:-0}" == "1" ]] || open "$URL"
    exit 0
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    rm -f "$PID_FILE"
    echo "服务启动失败。日志：$LOG_FILE"
    tail -n 20 "$LOG_FILE" 2>/dev/null || true
    read "?按回车关闭……"
    exit 1
  fi
  sleep 0.25
done

kill "$SERVER_PID" 2>/dev/null || true
rm -f "$PID_FILE"
echo "服务等待超时。日志：$LOG_FILE"
read "?按回车关闭……"
exit 1
