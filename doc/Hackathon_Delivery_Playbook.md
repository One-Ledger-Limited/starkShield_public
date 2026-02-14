# StarkShield Hackathon Delivery Playbook (1-2 Weeks)

## 0. Purpose
This playbook defines a **hackathon-feasible** execution plan while leaving clear upgrade hooks for production.

- Track A: Demo-ready in 1-2 weeks
- Track B: Future production hardening (deferred but pre-designed)

## 1. Scope and Non-Goals

### In Scope (Hackathon)
- Wallet connect and trade form UX
- Public vs Shielded mode switch
- Local proof generation progress UI (real or simulated fallback)
- Relay API for intent submission and matching
- Basic matching rule: **Price-Time Priority**
- On-chain settlement flow (or testnet stub)
- Result comparison panel: price/slippage/MEV saved
- Minimal audit logging (non-sensitive)

### Out of Scope (Deferred)
- Formal verification
- Full cryptographic key lifecycle (KMS/HSM)
- Regulatory rollout package
- High-availability multi-region deployment

## 2. Security Baseline (Hackathon)

### 2.1 Trust Assumption
- Relay is **semi-trusted**:
  - trusted for availability and message forwarding
  - not trusted for privacy beyond encrypted payload boundaries

### 2.2 Intent Anti-Replay Schema (Must Have)
Every signed intent must include:
- `intentId` (UUID v4)
- `userAddress`
- `chainId`
- `nonce` (monotonic per user)
- `expiry` (unix timestamp)
- `domainSeparator` (app + env)
- `version`

Server and contract reject if:
- `expiry < now`
- `nonce already used`
- `signature invalid`
- `chainId mismatch`

### 2.3 Key Handling
- Private key stays in wallet only
- Frontend stores no private key and no seed phrase
- If local encryption key exists, keep in memory only (no localStorage persistence)

### 2.4 Frontend Tamper Mitigation (Lightweight)
- Version-pin frontend artifact (`APP_BUILD_ID`)
- Publish SHA256 checksum per release
- Log build id with every relay request

## 3. Matching Rules (Hackathon Spec)

### 3.1 Deterministic Policy (V1)
- Primary: best price
- Secondary: earliest `receivedAt`
- No partial fill in V1
- Intent timeout by `expiry`
- User cancellation supported if not settled

### 3.2 State Machine
- `CREATED` -> `SUBMITTED` -> `MATCHED` -> `CONFIRMED` -> `SETTLED`
- Terminal failures: `EXPIRED`, `CANCELLED`, `REJECTED`, `FAILED`

## 4. Contract Minimal Spec (Hackathon)

### 4.1 Minimal Interface
- `submitIntent(bytes intent, bytes sig)`
- `settleMatch(bytes matchBundle, bytes zkProof)`
- `cancelIntent(bytes32 intentHash)`

### 4.2 Events (For Forensics Hook)
- `IntentSubmitted(intentHash, user, nonce, expiry, correlationId)`
- `IntentCancelled(intentHash, user, reasonCode, correlationId)`
- `MatchSettled(matchId, intentAHash, intentBHash, price, correlationId)`
- `SettlementFailed(matchId, reasonCode, correlationId)`

### 4.3 Error Codes
- `ERR_EXPIRED_INTENT`
- `ERR_NONCE_REPLAY`
- `ERR_BAD_SIGNATURE`
- `ERR_PRICE_OUT_OF_BOUNDS`
- `ERR_ALREADY_SETTLED`
- `ERR_UNAUTHORIZED`

### 4.4 Gas Guardrail
- Define target and hard stop:
  - target: `< 180,000`
  - hard limit alert: `>= 250,000`

## 5. Performance and SLA (Hackathon Targets)

### 5.1 Target Metrics
- Proof generation: `p95 < 60s`
- Match response: `p95 < 5s`
- API error rate: `< 2%`
- Demo uptime: `> 95%` during judging window

### 5.2 Measurement
- Every request includes `correlationId`
- Track client and server timestamps
- Export one daily CSV or JSON report

## 6. Testing and Acceptance Gates

### 6.1 Must-Pass E2E Scenarios
1. Happy path: shielded order -> matched -> settled
2. Expired intent rejected
3. Replay attack (`same nonce`) rejected
4. User cancels before match
5. Proof failure path shows deterministic fallback message

### 6.2 Adversarial Tests (Minimum)
- Tampered payload signature check fails
- Relay duplicate submission blocked by nonce rule
- Invalid chainId rejected

### 6.3 MEV Comparison Benchmark
- Fixed scenario dataset with same input size and slippage constraints
- Report fields:
  - public execution price
  - shielded execution price
  - slippage difference
  - estimated MEV saved
- Success criterion:
  - at least one deterministic case demonstrates lower slippage or better execution in shielded mode

## 7. Team Split: FE / BE / Testing

## Frontend Work Package

### FE-1 Wallet + Trade UI
- Connect wallet
- Token pair + amount + slippage input
- Mode selector (Public/Shielded)

### FE-2 Proof UX
- Start proof action
- Progress bar and stage timeline
- Timeout and retry UX

### FE-3 Matching and Settlement UX
- Show anonymized counterparty result
- Accept/Reject buttons
- Final result comparison table

### FE-4 Telemetry Hook
- Inject `correlationId`, `APP_BUILD_ID`
- Emit basic lifecycle logs

### FE Acceptance
- No private key persistence
- All state transitions visible in UI
- Errors mapped to readable messages

## Backend Work Package

### BE-1 Intent API
- `POST /v1/intents`
- Validate signature, nonce, expiry, chainId
- Persist intent state

### BE-2 Matching Engine V1
- Deterministic Price-Time matching
- No partial fill
- Background expiry sweeper

### BE-3 Settlement API
- `POST /v1/matches/{id}/confirm`
- `POST /v1/intents/{id}/cancel`
- Contract call adapter (testnet or stub)

### BE-4 Audit Logging
- Structured logs only (no plaintext sensitive content)
- Required fields: `timestamp, correlationId, userHash, intentHash, state, reasonCode`

### BE Acceptance
- Replay attempts blocked
- Expired intents never matched
- Deterministic output for same order sequence

## Testing Work Package

### QA-1 Automated E2E
- Cover 5 must-pass scenarios in Section 6.1

### QA-2 Security Regression Suite
- Replay/signature/chain mismatch tests

### QA-3 Performance Smoke
- 100 synthetic intents
- Report p50/p95 matching latency

### QA-4 Demo Checklist
- One-page runbook for judges
- Known limitations sheet

### Testing Acceptance
- Zero critical failures on E2E
- Security regressions all pass
- Performance report generated before submission

## 8. 2-Week Suggested Timeline

### Week 1
- Day 1-2: schema + API contract + FE skeleton
- Day 3-4: matching V1 + proof UI
- Day 5: end-to-end happy path + logging

### Week 2
- Day 6-7: replay/expiry/cancel hardening
- Day 8: adversarial tests + perf smoke
- Day 9: polish demo narrative and benchmark report
- Day 10: dry run, contingency fixes, submission package

## 9. Deferred Production Backlog (Keep Hooks Now)

### Security
- E2E encrypted transport with key rotation
- KMS/HSM and key revocation
- Frontend supply-chain signing and integrity policy

### Matching
- Partial fills
- Fairness/audit proofs for matching
- Risk controls and circuit breaker

### Contract
- Upgrade/versioning strategy
- Formal invariants and external audit prep

### Compliance
- Data retention and privacy policy
- Incident response and forensics SOP
- Jurisdiction legal mapping

## 10. Definition of Done (Hackathon)
A build is done when all conditions are met:
- 5 E2E must-pass scenarios green
- replay and expiry protections enforced in both API and contract/stub
- deterministic matching with documented policy
- result page includes transparent limitations and benchmark fields
- demo can be run by non-developer with one runbook
