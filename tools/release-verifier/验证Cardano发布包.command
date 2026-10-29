#!/bin/zsh
set -u

SCRIPT_DIR=${0:A:h}
VERIFIER="$SCRIPT_DIR/CardanoReleaseVerifier"
MANIFESTS=("$SCRIPT_DIR"/MANIFEST-*.sha256(N))
if (( ${#MANIFESTS[@]} > 0 )); then
  RELEASE_DIR="$SCRIPT_DIR"
else
  RELEASE_DIR=${SCRIPT_DIR:h}
fi

clear
echo "Cardano Sparrow / Cardano Watch 发布验证"
echo "-----------------------------------------"
if [[ ! -x "$VERIFIER" ]]; then
  echo "❌ 验证器缺失或不可执行：$VERIFIER"
  STATUS=1
else
  "$VERIFIER" "$RELEASE_DIR"
  STATUS=$?
fi
echo
read -r "?按回车关闭…"
exit $STATUS
