#!/usr/bin/env bash
set -euo pipefail

# Ensure frontend static circuit assets exist at frontend/public/circuits.
# If missing, generate them via circuits/scripts/generate_intent_vk_on_server.sh.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BUILD_DIR="$ROOT_DIR/circuits/build"
FRONTEND_CIRCUITS_DIR="$ROOT_DIR/frontend/public/circuits"

WASM_SRC="$BUILD_DIR/intent_circuit_js/intent_circuit.wasm"
ZKEY_SRC="$BUILD_DIR/intent_circuit_final.zkey"
VK_SRC="$BUILD_DIR/intent_verification_key.json"

missing=0
for f in "$WASM_SRC" "$ZKEY_SRC" "$VK_SRC"; do
  if [ ! -f "$f" ]; then
    missing=1
    break
  fi
done

if [ "$missing" -eq 1 ]; then
  echo "🧩 Circuit artifacts missing; generating intent circuit assets..."
  bash "$ROOT_DIR/circuits/scripts/generate_intent_vk_on_server.sh"
fi

mkdir -p "$FRONTEND_CIRCUITS_DIR"
cp -f "$WASM_SRC" "$FRONTEND_CIRCUITS_DIR/intent_circuit.wasm"
cp -f "$ZKEY_SRC" "$FRONTEND_CIRCUITS_DIR/intent_circuit_final.zkey"
cp -f "$VK_SRC" "$FRONTEND_CIRCUITS_DIR/intent_verification_key.json"

echo "✅ Frontend circuit assets prepared:"
ls -lh "$FRONTEND_CIRCUITS_DIR"/intent_circuit.wasm \
       "$FRONTEND_CIRCUITS_DIR"/intent_circuit_final.zkey \
       "$FRONTEND_CIRCUITS_DIR"/intent_verification_key.json
