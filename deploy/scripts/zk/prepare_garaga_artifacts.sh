#!/usr/bin/env bash
set -euo pipefail

# Build verifier artifacts required for on-chain Garaga deployment.
#
# Steps:
# 1) Generate/refresh intent verification key (snarkjs)
# 2) Generate Garaga verifier Cairo project
# 3) Build contracts and generated verifier project

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT_DIR"

echo "🧩 Generating intent verification key..."
bash circuits/scripts/generate_intent_vk_on_server.sh

echo "🧩 Generating Garaga verifier project..."
bash circuits/scripts/generate_garaga_verifier_on_server.sh

echo "🔨 Building local contracts..."
(cd contracts && scarb build)

echo "🔨 Building generated Garaga verifier..."
(cd contracts/garaga_intent_verifier && scarb build)

echo "✅ Artifacts ready"
echo "Next: run deploy/scripts/zk/deploy_garaga_stack_starkli.sh"
