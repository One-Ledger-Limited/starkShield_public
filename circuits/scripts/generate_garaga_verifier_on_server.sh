#!/usr/bin/env bash
set -euo pipefail

# Generate a Cairo Groth16 verifier project from the circuit verification key via Garaga.
#
# Required input:
#   circuits/build/intent_verification_key.json
#
# Output:
#   contracts/garaga_intent_verifier/  (Garaga-generated Cairo project)
#
# Usage:
#   bash circuits/scripts/generate_garaga_verifier_on_server.sh
#
# Optional env:
#   GARAGA_IMAGE=ghcr.io/keep-starknet-strange/garaga:latest
#   GARAGA_PROJECT_NAME=garaga_intent_verifier
#   GARAGA_PYPI_SPEC=garaga==0.18.2

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VK_PATH="$ROOT_DIR/circuits/build/intent_verification_key.json"
CONTRACTS_DIR="$ROOT_DIR/contracts"
GARAGA_PROJECT_NAME="${GARAGA_PROJECT_NAME:-garaga_intent_verifier}"
GARAGA_IMAGE="${GARAGA_IMAGE:-}"
GARAGA_PYPI_SPEC="${GARAGA_PYPI_SPEC:-garaga==0.18.2}"
SCARB_VERSION="${SCARB_VERSION:-2.16.0}"
CACHE_DIR="$ROOT_DIR/.cache/garaga"

if ! command -v docker >/dev/null 2>&1; then
  echo "❌ docker is required" >&2
  exit 1
fi

if [ ! -f "$VK_PATH" ]; then
  echo "❌ Missing verification key: $VK_PATH" >&2
  echo "Run circuits/scripts/generate_intent_vk_on_server.sh first." >&2
  exit 1
fi

mkdir -p "$CONTRACTS_DIR"
mkdir -p "$CACHE_DIR/root_local" "$CACHE_DIR/pip"

run_with_image() {
  local image="$1"
  echo "🐳 Generating Garaga verifier project via image: $image"
  docker run --rm \
    -v "$ROOT_DIR":/work -w /work/contracts \
    "$image" \
    garaga gen \
      --system groth16 \
      --vk /work/circuits/build/intent_verification_key.json \
      --project-name "$GARAGA_PROJECT_NAME"
}

run_with_pypi() {
  echo "🐳 Generating Garaga verifier project via PyPI package: $GARAGA_PYPI_SPEC"
  local extra_mount=()
  if [ -x "$HOME/.local/bin/scarb" ]; then
    extra_mount=( -v "$HOME/.local/bin/scarb:/usr/local/bin/scarb:ro" )
  fi
  docker run --rm \
    -v "$ROOT_DIR":/work -w /work/contracts \
    -v "$CACHE_DIR/root_local":/root/.local \
    -v "$CACHE_DIR/pip":/root/.cache/pip \
    "${extra_mount[@]}" \
    python:3.10-slim \
    bash -lc "set -euo pipefail; \
      apt-get update >/dev/null; \
      apt-get install -y --no-install-recommends curl ca-certificates xz-utils >/dev/null; \
      if ! command -v scarb >/dev/null 2>&1; then \
        curl --proto '=https' --tlsv1.2 -sSf https://docs.swmansion.com/scarb/install.sh | sh -s -- -v \"$SCARB_VERSION\"; \
      fi; \
      export PATH=\"\$HOME/.local/bin:\$PATH\"; \
      pip install --no-cache-dir \"$GARAGA_PYPI_SPEC\"; \
      garaga gen --system groth16 --vk /work/circuits/build/intent_verification_key.json --project-name \"$GARAGA_PROJECT_NAME\""
}

apply_cairo_compat_patch() {
  local constants_file="$CONTRACTS_DIR/$GARAGA_PROJECT_NAME/src/groth16_verifier_constants.cairo"
  if [ ! -f "$constants_file" ]; then
    echo "❌ Missing generated constants file: $constants_file" >&2
    exit 1
  fi

  # Garaga may emit non-generic type annotations that fail under newer Cairo compilers.
  # Pin explicit generics for BN254 constants.
  sed -i.bak -E \
    's/^pub const vk: Groth16VerifyingKey = /pub const vk: Groth16VerifyingKey<u288> = /' \
    "$constants_file"
  sed -i -E \
    's/^pub const precomputed_lines: \[G2Line; ([0-9]+)\] = /pub const precomputed_lines: [G2Line<u288>; \1] = /' \
    "$constants_file"
}

if [ -n "$GARAGA_IMAGE" ]; then
  if ! run_with_image "$GARAGA_IMAGE"; then
    echo "⚠️  GARAGA_IMAGE failed, falling back to PyPI"
    run_with_pypi
  fi
else
  run_with_pypi
fi

apply_cairo_compat_patch

echo "✅ Generated: $CONTRACTS_DIR/$GARAGA_PROJECT_NAME"
echo "ℹ️  Deploy the generated verifier contract and set its address in IntentVerifier."
