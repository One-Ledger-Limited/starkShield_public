# Changelog

## [0.1.70] - 2026-02-25

### Fixed
- Updated public docs to use the real open-source repository URL (`https://github.com/Shield-Trade/starkShield_public`) instead of placeholder `your-org` links.
- Fixed docs/API request examples to match current solver payload requirements by including `proof_public_inputs` and extended `public_inputs` fields (`nonce`, `chain_id`, `domain_separator`, `version`).
- Updated docs/API response/error examples to include `correlation_id` for operational troubleshooting consistency.
- Updated docs endpoint examples to prefer `/v1/...` routes and explicitly list supported legacy aliases.
- Corrected contract documentation to describe `proof_data` as dynamic Garaga calldata (not fixed 8 elements).

## [0.1.69] - 2026-02-25

### Fixed
- Frontend approval UX now waits for `approve` transaction confirmation (`starknet_getTransactionReceipt`) before re-checking allowance/auto-submit, reducing repeated approval prompts and duplicate gas spend while the tx is still pending.
- Frontend insufficient-allowance message now includes token, current allowance, required amount, and spender address to make approval mismatches diagnosable.

## [0.1.68] - 2026-02-25

### Fixed
- Solver settlement flow no longer blocks on transient RPC precheck outages/rate-limit (`cu limit exceeded`/`request too fast`): when precheck is unavailable, matcher now proceeds with on-chain settlement attempt instead of leaving pairs stuck in `Matched`.
- Fixed Redis match cleanup to delete both `intents:matched` membership and `matched:<id>` payload when a match is settled, preventing stale matched records from showing after successful settlement.

## [0.1.67] - 2026-02-24

### Fixed
- Fixed `contracts/src/IntentVerifier.cairo` Garaga return decoding: `verify_groth16_proof_bn254` returns `Option<Span<u256>>` with `Some` tag `0`, so adapter success check now uses `option_tag == 0` instead of `!= 0` (which previously inverted success/failure and caused valid proofs to be rejected as `Invalid proof`).
- Fixed `deploy/scripts/zk/deploy_garaga_stack_starkli.sh` class-hash parsing to avoid picking CASM hash lines during declare retries, preventing false `Class ... is not declared` deploy failures.

## [0.1.66] - 2026-02-24

### Fixed
- Normalized frontend submit-time felts (`intent_hash`, `nullifier`, `proof_public_inputs`) into Starknet field range before preflight/submit, preventing `representative out of range` parsing failures (e.g., `intent_hash parse error`) on solver preflight.

## [0.1.65] - 2026-02-24

### Fixed
- Removed frontend Garaga preflight fallback-to-first-candidate behavior when preflight is unavailable. Candidate selection now requires explicit preflight success, preventing `preflight unavailable` warnings from masking invalid submissions.

## [0.1.64] - 2026-02-24

### Fixed
- Frontend calldata candidate preflight now treats `failed to create Felt from string` / `representative out of range` as deterministic candidate rejection (not `preflight unavailable`), preventing invalid fallback selection that later fails solver submit preflight.
- Solver proof preflight parsing errors now include precise field context (`intent_hash`, `nullifier`, `proof_data[i]`, `proof_public_inputs[i]`) and value preview to speed up root-cause diagnosis.

## [0.1.63] - 2026-02-24

### Changed
- Deployment now resets solver runtime intent state on every release by running `deploy/scripts/clear-intent-state.sh` from `deploy.sh`.
- Added `deploy/scripts/clear-intent-state.sh` to clear Redis intent/match lifecycle keys (`pending`, `matched`, and stored intent records including cancelled entries), ensuring a clean post-deploy state.

## [0.1.62] - 2026-02-24

### Fixed
- Added explicit solver logging for proof preflight rejections in `submit_intent`, including `correlation_id`, `user`, `nullifier`, and detailed reject reason to make `INVALID_PROOF` failures diagnosable from server logs.
- Updated frontend `INVALID_PROOF` error rendering to surface backend error details directly (including `correlation_id` when present), instead of always showing a generic message.

## [0.1.61] - 2026-02-24

### Fixed
- Fixed frontend Garaga preflight candidate selection: preflight-unavailable candidates no longer short-circuit selection. The app now keeps evaluating all candidate mappings and only stops early on explicit preflight success, reducing false `INVALID_PROOF` submissions caused by premature fallback.

## [0.1.60] - 2026-02-24

### Fixed
- Hardened frontend Garaga calldata selection with on-chain preflight: each parser/typed candidate is now validated via `starknet_call` against `DarkPool.submit_intent` before use, reducing deterministic `INVALID_PROOF` loops caused by choosing a syntactically valid but on-chain-invalid calldata mapping.

## [0.1.59] - 2026-02-24

### Fixed
- Frontend submit flow now auto-recovers from `INVALID_PROOF`: when solver preflight rejects a proof, the app regenerates ZK proof once and retries submit automatically, reducing manual rework and preventing repeated stalled submissions.

## [0.1.58] - 2026-02-24

### Fixed
- Added solver-side proof preflight at submit time: `submit_intent` now simulates `DarkPool.submit_intent` via Starknet JSON-RPC and rejects invalid proofs before enqueue, preventing orders from reaching `matched` and then failing settlement with on-chain `Invalid proofs`.

## [0.1.57] - 2026-02-24

### Fixed
- Hardened `deploy/scripts/zk/deploy_garaga_stack_starkli.sh` nonce handling for `starkli deploy/invoke`: nonce errors (`InvalidTransactionNonce` / `NonceTooOld`) now keep retrying with refreshed nonce + backoff instead of failing the rollout mid-way.
- Tightened deploy failure detection for Garaga verifier and IntentVerifier adapter deployment: script now exits on actual command failure instead of relying on output-string heuristics.

## [0.1.56] - 2026-02-24

### Fixed
- Settlement proof calldata generation now prioritizes Garaga parser with G2-order candidate matching (`proof/vk: swapped|canonical`) before typed fallback, so curve-invalid orderings are rejected early instead of producing on-chain `Invalid proofs`.

## [0.1.55] - 2026-02-24

### Fixed
- Updated solver submit validation for `proof_public_inputs` to accept Groth16-native payloads with `nPublic=3` (instead of enforcing a legacy minimum of 6), resolving `Invalid proof_public_inputs (expected at least 6 elements)` on intent submission.

## [0.1.54] - 2026-02-24

### Fixed
- Fixed proof public inputs payload for settlement: frontend now submits SNARK-native `publicSignals` as `proof_public_inputs` (instead of business fields), aligning with verifier `nPublic` and preventing on-chain `Invalid proofs` during settlement.

## [0.1.53] - 2026-02-24

### Fixed
- Hardened frontend token approval flow against intermittent wallet/provider JSON-RPC parse failures (`Unexpected end of JSON input`): approval transaction now retries once for transient RPC errors.
- Tightened approval fallback behavior: `approve(0) -> approve(N)` is now only used for allowance-related failures, preventing unrelated RPC parse errors from entering an incorrect fallback path.

## [0.1.52] - 2026-02-24

### Fixed
- Adjusted frontend Garaga typed G2 candidate priority to try `swapped/swapped` first (snarkjs-emitted bn128 ordering), reducing cases where calldata builds successfully but fails on-chain with `Invalid proofs`.

## [0.1.51] - 2026-02-23

### Fixed
- Solver retry policy now treats `Invalid proofs` as retry-managed failures: it applies exponential backoff immediately and no longer retries every cycle.
- Added terminal retry cutoff for invalid-proof matches (`MAX_INVALID_PROOF_RETRIES`, default `5`): once reached, the match is removed from the active retry queue to prevent runaway RPC usage.
- Added `MAX_INVALID_PROOF_RETRIES` and `POLL_INTERVAL_MS` to `.env.example` for explicit retry-tuning.

## [0.1.50] - 2026-02-23

### Fixed
- Hardened frontend Garaga calldata construction to try all typed G2 limb-order combinations independently for proof and verification key (`canonical/swapped` x `canonical/swapped`), reducing false `Point ... is not on the curve` failures.
- Demoted `get_groth16_calldata` parser path to a last-resort fallback and normalized parser G2 inputs to affine format (`[x, y]` only), avoiding parser-side G1/G2 shape confusion.

## [0.1.49] - 2026-02-23

### Fixed
- Fixed Garaga calldata build regression in frontend `create pair`: parser inputs are now normalized to snarkjs-compatible affine G1 shapes (`[x, y]`), preventing `Failed to parse G1PointBigUint`.
- Restored robust typed fallback order for Garaga calldata generation (`canonical` then `swapped`) when parser path fails, reducing false `Point ... is not on the curve` failures.

## [0.1.48] - 2026-02-23

### Fixed
- Hardened frontend Garaga proof calldata generation: now prioritizes Garaga's native parser path (`get_groth16_calldata`) and keeps typed mapping as fallback, reducing false-valid calldata generation that later fails on-chain with `Invalid proofs`.
- Added mandatory local `snarkjs` verification right after proof generation (`groth16.verify` vs verification key) to fail fast before submitting invalid intents.

## [0.1.47] - 2026-02-23

### Fixed
- Fixed frontend Garaga calldata generation for `create pair`: G2 coordinate parsing now tries canonical order first and automatically falls back to swapped order, resolving `Point ... is not on the curve` errors caused by proof/vkey limb-order differences.

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
- Added `deploy/scripts/prepare_frontend_circuit_assets.sh` and wired it into `deploy.sh` so frontend `/circuits/*` assets are prepared before image build.
- Updated frontend proof asset URLs to support env overrides and improved missing-asset errors (avoid opaque wasm magic-number failures).
- Fixed intent proof witness generation by providing all required circuit inputs (`intentHash`, `nullifier`, `currentTime`) and switching frontend hash/nullifier derivation to Poseidon to match `intent_circuit.circom`.
- Fixed browser runtime error `Buffer is not defined` during ZK proof generation by adding Vite node polyfills and explicit `globalThis.Buffer` initialization.
- Fixed matcher compatibility checks for decimal amounts (`0.1`, etc.) by comparing base-unit values from `proof_public_inputs` (with backward-compatible fallback parsing), preventing valid reciprocal intents from staying indefinitely pending.
- Updated frontend proof submission to send Garaga `full_proof_with_hints` calldata (instead of only 8 Groth16 coordinates), aligning with generated verifier input requirements and resolving on-chain `Invalid proofs` rejections.
- Corrected Garaga proof/vk object mapping to official `Groth16Proof` / `Groth16VerifyingKey` shapes (with BN254 `curveId` and bigint coordinates), fixing `Failed to parse G1PointBigUint` during proof creation.
- Switched Groth16 calldata generation to Garaga's wasm parser path (`get_groth16_calldata`) with typed fallback, reducing proof/vk field-order mismatch risk that caused on-chain `Invalid proofs`.
- Fixed `IntentVerifier` adapter ABI forwarding: now prepends `proof_data` length before `call_contract_syscall` to Garaga (`Span<felt252>`), preventing false `Invalid proofs` on matched intents.
- Hardened frontend Garaga calldata generation to use a single typed path (`getGroth16CallData`) and corrected snarkjs->Garaga G2 coordinate order mapping (`[x1,x0]/[y1,y0]` -> `[x0,x1]/[y0,y1]`).

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
