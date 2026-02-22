#!/usr/bin/env bash
set -euo pipefail

# Generates Groth16 verification key for intent circuit on a host with Docker.
# Output: circuits/build/intent_verification_key.json (plus intermediate build/* and ptau/*)

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CIRCUITS_DIR="$ROOT_DIR/circuits"

CIRCOM_TAG="${CIRCOM_TAG:-v2.1.9}"
POT_POWER="${POT_POWER:-18}"
PTAU_DIR="$CIRCUITS_DIR/ptau"
BUILD_DIR="$CIRCUITS_DIR/build"

if ! command -v docker >/dev/null 2>&1; then
  echo "❌ docker is required" >&2
  exit 1
fi

mkdir -p "$PTAU_DIR" "$BUILD_DIR" "$CIRCUITS_DIR/tooling"

echo "🐳 Ensuring node modules (circuits)"
docker run --rm \
  -v "$ROOT_DIR":/work -w /work/circuits \
  node:18-bullseye bash -lc "npm install --no-audit --no-fund"

echo "🐳 Building circom from source (one-time)"
# Build in bullseye to match the node:18-bullseye runtime glibc.
if [ ! -x "$CIRCUITS_DIR/tooling/circom" ]; then
  docker run --rm \
    -v "$ROOT_DIR":/work -w /work \
    rust:1.88-bullseye bash -lc "set -e; export PATH=/usr/local/cargo/bin:\$PATH; apt-get update; apt-get install -y git build-essential pkg-config libssl-dev; rm -rf /var/lib/apt/lists/*; cd /tmp; git clone --depth 1 --branch ${CIRCOM_TAG} https://github.com/iden3/circom.git; cd circom; cargo build --release; cp -f target/release/circom /work/circuits/tooling/circom; chmod +x /work/circuits/tooling/circom"
fi

echo "🧩 Compiling intent circuit"
docker run --rm \
  -v "$ROOT_DIR":/work -w /work/circuits \
  node:18-bullseye bash -lc "./tooling/circom intent_circuit.circom --r1cs --wasm --sym -o build"

POT_0000="$PTAU_DIR/pot${POT_POWER}_0000.ptau"
POT_FINAL="$PTAU_DIR/pot${POT_POWER}_final.ptau"

if [ ! -f "$POT_FINAL" ]; then
  echo "🧪 Generating Powers of Tau (bn128, 2^${POT_POWER})"
  docker run --rm \
    -v "$ROOT_DIR":/work -w /work/circuits \
    node:18-bullseye bash -lc "npx -y snarkjs powersoftau new bn128 ${POT_POWER} ptau/pot${POT_POWER}_0000.ptau -v && \
      npx -y snarkjs powersoftau contribute ptau/pot${POT_POWER}_0000.ptau ptau/pot${POT_POWER}_final.ptau --name='StarkShield Hackathon' -v -e='starkshield-hackathon'"
fi

echo "🔧 Groth16 setup + export verification key"
docker run --rm \
  -v "$ROOT_DIR":/work -w /work/circuits \
  node:18-bullseye bash -lc "npx -y snarkjs groth16 setup build/intent_circuit.r1cs ptau/pot${POT_POWER}_final.ptau build/intent_circuit_final.zkey && \
    npx -y snarkjs zkey export verificationkey build/intent_circuit_final.zkey build/intent_verification_key.json"

echo "✅ Wrote: $BUILD_DIR/intent_verification_key.json"