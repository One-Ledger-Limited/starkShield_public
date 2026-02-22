# Changelog

## [0.1.46] - 2026-02-22

### Security
- Replaced placeholder `IntentVerifier` logic with a Garaga adapter that forwards proof calldata to a deployed Garaga Groth16 verifier contract.
- Added owner-gated admin methods in `IntentVerifier` to rotate/update the Garaga verifier contract address.
- Removed frontend mock-proof fallback; proof generation now fails closed if SNARK artifacts are unavailable.

### Added
- Added `circuits/scripts/generate_garaga_verifier_on_server.sh` to generate a Cairo verifier project from `circuits/build/intent_verification_key.json` using Garaga.
- Added `deploy/scripts/zk/prepare_garaga_artifacts.sh` and `deploy/scripts/zk/deploy_garaga_stack_starkli.sh` to automate on-chain Garaga verifier rollout and `DarkPool.update_verifier`.
- Added `deploy/scripts/zk/rollout_garaga_on_server.sh` to run server-side end-to-end rollout with build retries and Starkli env wiring.
- Hardened `deploy/scripts/zk/deploy_garaga_stack_starkli.sh` with nonce/rate-limit retries and automatic CASM-hash fallback for declare mismatch errors.
- Updated `deploy/scripts/zk/rollout_garaga_on_server.sh` to read required values from `.env` directly and default to `ZAN /rpc/v0_8` for starkli compatibility.

## [0.1.45] - 2026-02-22

### Security
- **CRITICAL**: Fixed `cancel_intent` access control - now properly verifies caller is the intent owner
- Added intent owner storage to track who submitted each intent
- Implemented proper `pause/unpause` functionality with state checks in `submit_intent` and `settle_match`

### Fixed
- Matcher now uses `BigUint` for amount comparisons instead of `f64`, eliminating floating-point precision issues in large trades
- Improved surplus calculation accuracy for matched pairs

### Changed
- Contract storage now includes `intent_owners` mapping and `paused` flag
- Enhanced contract initialization to set `paused = false` by default

## [0.1.42] - 2026-02-14

### Fixed
- Solver API token balance/allowance prechecks now use `pending` state and accept more JSON-RPC return shapes, reducing `Token balance/allowance response missing fields`.
- Frontend now maps `INSUFFICIENT_ALLOWANCE` to `Please approve the Dark Pool contract before submitting.`

## [0.1.43] - 2026-02-14

### Fixed
- Frontend/solver Starknet RPC precheck now falls back from `pending` to `latest` when the RPC provider returns `Invalid params`, so approval requirements are detected reliably.

## [0.1.44] - 2026-02-14

### Fixed
- Solver settlement retry loop now backs off after 3 consecutive `INSUFFICIENT_BALANCE/INSUFFICIENT_ALLOWANCE` failures to reduce log spam and RPC load.

## [0.1.38] - 2026-02-14

### Fixed
- Settlement calldata now prefers prover-generated `public_inputs` (base units) provided at intent creation time, eliminating token-decimals/unit ambiguity that could settle `20 STRK` as `0.0000000000000002 STRK`.

## [0.1.39] - 2026-02-14

### Fixed
- Frontend precheck now falls back to calling `VITE_STARKNET_RPC` directly if the solver RPC proxy is unreachable.
- Solver settlement retries now handle additional nonce-error wording (`Invalid transaction nonce ... Account nonce: ...`) and no longer advances the cached nonce until a tx is successfully submitted.

## [0.1.40] - 2026-02-14

### Changed
- Approval is no longer unlimited by default. Users can configure an approval buffer percent (default 20%) and the app will approve `required * (1 + buffer%)`.

## [0.1.41] - 2026-02-14

### Fixed
- When an approval tx is submitted, the UI now shows a loading indicator while waiting for the allowance to update on-chain.

## [0.1.37] - 2026-02-14

### Fixed
- Frontend approval flow now approves a max allowance (and first checks existing allowance) to avoid repeated approval transactions and fees for subsequent trades.

## [0.1.36] - 2026-02-14

### Changed
- Solver prechecks are now disabled by default in `docker-compose.prod.yml` (`ENFORCE_PRECHECKS` defaults to `false`). Frontend still performs a best-effort balance/allowance precheck.

### Fixed
- Reverted frontend intent submission to send human-readable `amount_in` / `min_amount_out` strings (solver converts to base units during settlement).

## [0.1.35] - 2026-02-14

### Fixed
- Frontend precheck copy: changed allowance error text to `Please approve the Dark Pool contract before submitting.`
- Frontend precheck now uses a local token-decimals map (ETH/STRK=18, USDC/USDT=6) and shows human-readable balance/required amounts to make unit issues obvious.

## [0.1.34] - 2026-02-14

### Fixed
- Frontend intent submission now converts `amount_in` / `min_amount_out` into base units using the correct token decimals before sending to the solver/on-chain settlement.
  - Fixes cases like `0.1 ETH -> 10 STRK` settling as `0.00000000000000001 STRK` (treating `"10"` as 10 wei).

## [0.1.33] - 2026-02-14

### Fixed
- Solver settlement nonce races: serialize on-chain settlement tx submissions and cache/reserve nonces (with retry on `NonceTooOld`), preventing intermittent `InvalidTransactionNonce` failures when multiple matches are settled close together.

## [0.1.32] - 2026-02-14

### Fixed
- On-chain settlement calldata encoding: `amount_in` / `min_amount_out` are now consistently interpreted as **human token amounts** (not base units) and converted using the correct token decimals.
  - Fixes cases like `0.01 ETH -> 10 STRK` where `"10"` was previously treated as 10 wei.
  - Adds correct 6-decimal handling for USDC/USDT.

## [0.1.31] - 2026-02-14

### Security
- Removed demo credentials from the frontend UI.
- Solver no longer ships hardcoded defaults for `JWT_SECRET` / `AUTH_PASSWORD` when `REQUIRE_AUTH=true` (will refuse to start if missing).

### Changed
- Removed internal IP/host defaults from deployment templates and production compose config.
- Added `.gitignore`, `.env.example`, and `SECURITY.md` for public GitHub publishing.
- Scrubbed local absolute paths from documentation.

## [0.1.19] - 2026-02-13

### Fixed
- Solver on-chain auto-settlement no longer fails with `representative out of range` when encoding large 256-bit values (e.g. `nullifier` / `intent_hash`): values are reduced modulo the Starknet field prime before converting to `felt252`.

## [0.1.20] - 2026-02-13

### Fixed
- Solver on-chain auto-settlement now accepts human-readable decimal amounts like `0.01` for STRK/ETH by converting to 18-decimal base units during calldata encoding.

## [0.1.21] - 2026-02-14

### Fixed
- Pragma TWAP on Sepolia: suppress noisy error logs for the expected `Not enough data` revert and cache recent price responses (short TTL) to reduce repeated RPC calls and UI flapping.

## [0.1.22] - 2026-02-14

### Changed
- Trade form slippage box wording: show "Minimum to receive" and "Implied min rate" (plus reciprocal for very large/small rates) to avoid confusion like `1000 STRK/ETH` being interpreted as an amount.
- Slippage label clarified as "vs oracle" (TWAP may fall back to spot median on Sepolia).

## [0.1.14] - 2026-02-13

### Fixed
- ZK proof generation now persists a local proof history that can be viewed in the "ZK Proofs" tab.
- "How It Works" flow stepper now updates after proof creation and intent submission (not only wallet/login).

## [0.1.15] - 2026-02-13

### Fixed
- Generated (but not yet submitted) proofs are now restored when returning to the "New Trade" tab, so they don't disappear on tab switches.
- Intent Status empty state now hints when a local proof exists but hasn't been submitted yet.

## [0.1.16] - 2026-02-13

### Added
- Redis now uses AOF persistence and a named volume so intents survive restarts/deploys.
- Trade submit now runs a Starknet ERC20 balance/allowance precheck (UX) and the solver can enforce the same checks (`ENFORCE_PRECHECKS`).

## [0.1.17] - 2026-02-13

### Added
- When allowance is insufficient, the trade form now offers an "Approve Token for Dark Pool" action (wallet transaction).

## [0.1.18] - 2026-02-13

### Fixed
- Solver CORS can now be set to `*` to avoid browser blocks for `/v1/starknet-rpc` prechecks.
- Precheck error now shows the underlying message to help diagnose RPC/CORS issues.

## [0.1.19] - 2026-02-13

### Fixed
- `/v1/starknet-rpc` and `/v1/prices/pragma/twap` now always respond with permissive CORS headers, even if private endpoints use a restricted origin allow-list.

## [0.1.20] - 2026-02-13

### Fixed
- On HTTPS deployments, the frontend now uses `/api` as the solver base URL to avoid mixed-content blocks (expects a same-origin reverse proxy).
- Precheck now errors clearly when `/v1/starknet-rpc` returns non-JSON-RPC responses (e.g., SPA fallback HTML).

## [0.1.21] - 2026-02-13

### Fixed
- Frontend production container now proxies same-origin `/api/*` to the solver service, so HTTPS deployments can call solver endpoints without mixed-content issues.

## [0.1.22] - 2026-02-13

### Fixed
- When the solver returns `UNAUTHORIZED` (e.g., stale/expired JWT after redeploy), the frontend now clears the token and prompts the user to login again instead of staying in a broken "logged-in" state.

## [0.1.23] - 2026-02-13

### Changed
- Added `REQUIRE_AUTH` (solver) and `VITE_REQUIRE_LOGIN` (frontend) flags so deployments can run without a login UI. For the production compose file, login is disabled by default.

## [0.1.24] - 2026-02-13

### Fixed
- Intent Status now fetches pending intents for the connected wallet directly from the solver (no longer relies on browser localStorage nullifier history).
- After an on-chain `approve`, the UI now waits for allowance to reflect on RPC and auto-submits the intent (reduces "approved but no intent recorded" confusion).

## [0.1.25] - 2026-02-13

### Fixed
- If a locally saved draft/proof has an expired `deadline`, the UI now clears it and forces regenerating a fresh proof instead of failing later with `ERR_EXPIRED_INTENT`.

## [0.1.26] - 2026-02-13

### Fixed
- Intent Status filtering is now robust to Starknet address zero-padding differences (e.g., `0x03...` vs `0x003...`) so submitted intents show up reliably.

## [0.1.27] - 2026-02-13

### Fixed
- Solver Redis storage no longer deadlocks when pending intents exist (this was causing `Intent Status` and `/v1/health` to hang/time out after submissions).

## [0.1.28] - 2026-02-13

### Added
- Solver now indexes intents by user and exposes `GET /v1/intents/by-user?user=...` so `Intent Status` works across browsers/devices (not only for locally stored nullifiers or pending-only views).

## [0.1.29] - 2026-02-13

### Changed
- When `AUTO_SETTLE_ONCHAIN=true`, solver auto-submits a Starknet settlement transaction immediately after a match is created (no manual confirm step).
- IntentVerifier simplified for testnet deployments (no real Groth16 verification; NOT production secure).

## [0.1.10] - 2026-02-12

### Added
- STRK token option in the frontend token selector.
- Bastion-host deployment script for external-network deploys via jump host.

## [0.1.11] - 2026-02-12

### Fixed
- Trade form slippage display no longer computes percentage across different tokens; it now shows a minimum exchange rate, and only shows implied slippage for same-token trades.

## [0.1.12] - 2026-02-12

### Added
- Trade form can estimate slippage vs Pragma on-chain TWAP (using USD hops for the selected tokens).

## [0.1.13] - 2026-02-12

### Fixed
- Pragma TWAP fetching now goes through the solver backend (avoids browser RPC CORS blocks).

## [0.1.9] - 2026-02-12

### Fixed
- Frontend API client now prevents mixed-content calls on HTTPS pages by ignoring insecure `http://` solver API base URL and using same-origin requests.

## [0.1.8] - 2026-02-12

### Changed
- Login card now displays demo credentials directly under the login button for demo-only environments.

## [0.1.7] - 2026-02-12

### Fixed
- Wallet chain configuration now uses `starknet` canonical chain IDs (`constants.StarknetChainId`) to avoid wallet connect hanging.
- Braavos/Argent connect buttons are no longer force-disabled by pre-detection, allowing direct user-triggered connect attempts.

## [0.1.6] - 2026-02-12

### Fixed
- Wallet connect buttons now show explicit guidance when Argent X / Braavos extension is not injected.
- Added wallet connect error banner so failed connect attempts no longer appear as silent no-op.
- Wallet buttons are disabled when matching extension is unavailable in current browser context.

## [0.1.5] - 2026-02-12

### Fixed
- Frontend CSS pipeline now correctly processes Tailwind directives by adding `frontend/postcss.config.cjs`.
- Restored design-system utility styling (`.glass-card`, `.btn-primary`, `.btn-secondary`, `.btn-cta`) in production build.

## [0.1.4] - 2026-02-12

### Added
- Solver JWT authentication with login endpoint:
  - `POST /v1/auth/login`
  - bearer-token protection for intent/query/cancel/stats/match routes.
- Signature format validation for intent submission (`0x` + hex format).
- Secure deployment scripts:
  - key-based `auto-deploy.sh`
  - `deploy/scripts/verify-prod.sh`
  - `deploy/scripts/rollback.sh`
- Frontend login flow storing JWT in `localStorage.getItem('token')`.

### Changed
- Frontend trade/status error UX moved from `alert()` to inline message banners.
- Frontend `useDarkPool` now builds deterministic hex signatures for submissions.
- `docker-compose.prod.yml` now includes auth/security env vars (`JWT_SECRET`, `AUTH_*`).
- Integration tests now validate unauthorized access and authenticated request flow.

## [0.1.3] - 2026-02-09

### Added
- Centralized frontend API error message mapping in `frontend/src/constants/error-messages.ts`.
- v1 integration regression scenarios:
  - health check on `/v1/health`
  - intent submission on `/v1/intents`
  - nonce replay rejection
  - expired intent rejection
  - cancel intent lifecycle

### Changed
- `TradeForm` and `IntentStatus` now use shared error mapping for user-facing API failures.
- Solver error responses now include a consistent envelope with:
  - `success: false`
  - legacy `error` and `code` (backward compatible)
  - nested `error_detail { code, message }`
- Test scripts in `tests/package.json` now target actual test file location (`*.test.js`).

## [0.1.30] - 2026-02-14

### Changed
- Trade form: while token approval is in progress, both `Approve Token for Dark Pool` and `Submit Intent to Dark Pool` actions are disabled to prevent double-submit/misclicks.

## [0.1.2] - 2026-02-09

### Added
- Frontend API client at `frontend/lib/api-client.ts` with:
  - token header from `localStorage.getItem('token')`
  - `x-correlation-id` auto-injection
  - unified API error normalization
- Frontend Vite env typing in `frontend/src/vite-env.d.ts`.

### Changed
- `useDarkPool` now uses solver APIs instead of direct contract calls.
- Trade submission now posts to `/v1/intents` with required metadata:
  `nonce`, `chain_id`, `domain_separator`, `version`.
- Intent status view now reads real data from solver endpoints and supports cancel action via `/v1/intents/:nullifier/cancel`.

## [0.1.1] - 2026-02-09

### Added
- Solver v1 API routes aligned with hackathon playbook:
  - `POST /v1/intents`
  - `GET /v1/intents/:nullifier`
  - `POST /v1/intents/:nullifier/cancel`
  - `POST /v1/matches/:match_id/confirm`
  - `GET /v1/health`, `GET /v1/intents/pending`, `GET /v1/stats`
- Correlation ID support via `x-correlation-id` with automatic fallback generation.
- Anti-replay nonce reservation in Redis (`user + nonce`) with expiry-based TTL.
- Architecture document refreshed to hackathon-aligned runtime behavior.

### Changed
- Intent public input schema now includes `nonce`, `chain_id`, `domain_separator`, `version`.
- Submission flow now rejects expired intents before storage.
- Matcher now applies deterministic ordering and deterministic counterparty selection.
- Match settlement changed from auto-settle in matcher loop to explicit confirm endpoint flow.

### Fixed
- Redis intent TTL handling now guards against non-positive values.
- Mock pool address derivation no longer panics on short token strings.

### Notes
- Some production-grade hardening remains deferred by design (full signature verification pipeline, complete contract invariants, compliance package).
