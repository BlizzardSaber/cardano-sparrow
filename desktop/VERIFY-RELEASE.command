#!/bin/zsh
set -u

SCRIPT_DIR=${0:A:h}
for RELEASE_DIR in "$SCRIPT_DIR" "$SCRIPT_DIR/.." "$SCRIPT_DIR/../.."; do
  VERIFIER="$RELEASE_DIR/CardanoReleaseVerifier"
  if [[ -x "$VERIFIER" ]]; then
    "$VERIFIER" "$RELEASE_DIR"
    STATUS=$?
    echo
    read -r "?按回车退出…"
    exit $STATUS
  fi
done

echo "未找到原生 CardanoReleaseVerifier。请使用发布文件夹中的“验证Cardano发布包.command”。"
read -r "?按回车退出…"
exit 1
