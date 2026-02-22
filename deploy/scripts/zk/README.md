# ZK Verifier Deployment Scripts

## Purpose
These scripts automate migration from placeholder verifier wiring to a Garaga-backed on-chain verifier stack.

## Scripts
- `deploy/scripts/zk/prepare_garaga_artifacts.sh`
- `deploy/scripts/zk/deploy_garaga_stack_starkli.sh`
- `deploy/scripts/zk/rollout_garaga_on_server.sh`

## Flow
1. Generate verifier artifacts:
```bash
bash deploy/scripts/zk/prepare_garaga_artifacts.sh
```
2. Deploy and switch contracts (owner account must be configured in `starkli`):
```bash
OWNER_ADDRESS=0x... \
DARK_POOL_ADDRESS=0x... \
bash deploy/scripts/zk/deploy_garaga_stack_starkli.sh
```

## Notes
- `deploy_garaga_stack_starkli.sh` declares and deploys:
  - Garaga verifier contract (generated project)
  - `IntentVerifier` adapter from `contracts/IntentVerifier.cairo`
- Then it invokes `DarkPool.update_verifier(new_intent_verifier_address)`.
- `deploy_garaga_stack_starkli.sh` includes retries for nonce/rate-limit errors and CASM hash mismatch fallback.
- Recommended RPC for `starkli 0.4.x`: `https://api.zan.top/public/starknet-sepolia/rpc/v0_8`.
- If classes are already declared, use:
```bash
SKIP_DECLARE=1 \
GARAGA_CLASS_HASH=0x... \
INTENT_ADAPTER_CLASS_HASH=0x... \
OWNER_ADDRESS=0x... \
DARK_POOL_ADDRESS=0x... \
bash deploy/scripts/zk/deploy_garaga_stack_starkli.sh
```

### One-command server rollout
```bash
bash deploy/scripts/zk/rollout_garaga_on_server.sh
```
