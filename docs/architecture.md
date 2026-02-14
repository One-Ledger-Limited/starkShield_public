# StarkShield Architecture (Hackathon-Aligned)

## System Overview

StarkShield currently uses a four-layer architecture:

1. **Frontend (React + TypeScript)**
2. **Solver API (Rust + Axum + Redis)**
3. **Contracts (Cairo)**
4. **Circuits/Prover (circom + browser prover path)**

This document reflects the **current hackathon implementation baseline**, with explicit hooks for production hardening.

## Runtime Components

### 1. Frontend

Responsibilities:
- Wallet connect and trade input
- Public/Shielded mode UX
- Client-side proof generation UX and progress
- Submit intent and query status

Current notes:
- UI and proof workflow exist
- Some data paths still use placeholder/mock behavior and require backend integration polishing

### 2. Solver API

Responsibilities:
- Receive intent submissions
- Validate request shape and expiry
- Enforce anti-replay with `(user, nonce)` reservation
- Deterministic matching on token-pair books
- Intent cancellation and match confirmation endpoints

Current API (v1):
- `GET /v1/health`
- `POST /v1/intents`
- `GET /v1/intents/:nullifier`
- `POST /v1/intents/:nullifier/cancel`
- `POST /v1/matches/:match_id/confirm`
- `GET /v1/intents/pending`
- `GET /v1/stats`

Operational hooks:
- `x-correlation-id` supported and propagated in responses
- Structured error code fields for frontend mapping

### 3. Contracts (Cairo)

Responsibilities:
- Validate proof artifacts
- Track intent status lifecycle
- Execute settlement path

Current notes:
- Contract modules exist (`DarkPool.cairo`, `IntentVerifier.cairo`)
- Final production-safe checks (strict replay, complete authorization model, exhaustive revert reason taxonomy) are not fully hardened yet

### 4. Circuits

Responsibilities:
- Encode intent validity constraints
- Generate proof for shielded intent flow

Current notes:
- Circuit files and tests exist
- Performance optimization is roadmap work

## Matching Policy (V1)

Deterministic policy in solver:
- Group by complementary token pairs
- Process intents in stable order (`created_at`, then `nullifier`)
- Select compatible counterparty by best surplus, then earliest timestamp
- No partial fills in V1

## Security Baseline (Hackathon)

Implemented baseline:
- Expiry check on submission (`deadline > now`)
- Nonce replay protection (`user + nonce` reservation)
- Signature presence validation
- Correlation ID traceability

Deferred to production:
- Full signature verification pipeline
- Strong key lifecycle management (KMS/HSM)
- Full contract-side replay invariants and formal verification

## Performance Targets (Hackathon)

Target SLOs:
- Proof generation p95 < 60s
- Matching response p95 < 5s
- API error rate < 2%

These are tracked as acceptance targets and need automated reporting in CI/ops.

## Known Gaps

- Frontend-to-solver API contract still needs full end-to-end wiring across all tabs
- Some on-chain settlement paths remain simulated/stubbed in solver
- Contract hardening and audit scope remain deferred work

## Production Upgrade Hooks

Already reserved in model/API:
- intent metadata: `nonce`, `chain_id`, `domain_separator`, `version`
- cancel + confirm lifecycle endpoints
- correlation-based tracing for forensics

Planned upgrades:
- partial-fill and fairness proofs
- stronger policy engine and risk controls
- full compliance + audit evidence pipeline
