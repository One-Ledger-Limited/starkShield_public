use axum::{
    extract::{Json, Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::Json as JsonResponse,
    routing::{get, post},
    Router,
};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use std::collections::HashMap;
use tower_http::cors::{Any, CorsLayer};
use tracing::{debug, error, info, warn};

use crate::{
    auth::{issue_token, verify_token},
    config::{ApiConfig, Config},
    matcher::IntentMatcher,
    models::*,
    storage::RedisStorage,
    storage::SolverStats,
};
use serde::{Deserialize, Serialize};
use starknet::core::types::Felt;
use starknet::core::utils::{cairo_short_string_to_felt, get_selector_from_name};
use num_bigint::BigUint;
use num_traits::{Num, ToPrimitive};
use tokio::sync::{OnceCell, RwLock};

const ACCESS_TOKEN_EXPIRES_SECONDS: u64 = 3600;
type ApiResult<T> = std::result::Result<T, (StatusCode, JsonResponse<ErrorResponse>)>;

#[derive(Clone, Debug)]
struct CachedPragmaPrice {
    expires_at: u64,
    response: PragmaTwapResponse,
}

#[derive(Clone)]
pub struct AppState {
    storage: Arc<RedisStorage>,
    matcher: Arc<IntentMatcher>,
    start_time: u64,
    api_config: ApiConfig,
    starknet_rpc: String,
    pragma_summary_stats_address: Felt,
    pragma_oracle_address: Arc<OnceCell<Felt>>,
    pragma_price_cache: Arc<RwLock<HashMap<String, CachedPragmaPrice>>>,
    dark_pool_address: Felt,
    enforce_prechecks: bool,
}

pub fn create_router(storage: Arc<RedisStorage>, matcher: Arc<IntentMatcher>, config: Config) -> Router {
    fn normalize_starknet_rpc_url(raw: &str) -> String {
        // Many providers require an explicit JSON-RPC path (e.g. `/rpc/v0_8`).
        // If the env is given as a bare host, default to v0_8 for Starknet Sepolia.
        if let Ok(mut url) = reqwest::Url::parse(raw) {
            let path = url.path();
            if path.is_empty() || path == "/" {
                url.set_path("/rpc/v0_8");
                return url.to_string();
            }
        }
        raw.to_string()
    }

    let pragma_summary_stats_address = std::env::var("PRAGMA_SUMMARY_STATS_ADDRESS")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| {
            // Pragma "Realized Volatility / TWAP" contract on Starknet Sepolia.
            // Source: Pragma docs -> Advanced -> Overview -> Contract Addresses -> Sepolia Testnet.
            "0x49eefafae944d07744d07cc72a5bf14728a6fb463c3eae5bca13552f5d455fd".to_string()
        });
    let pragma_summary_stats_address = Felt::from_hex(&pragma_summary_stats_address)
        .expect("Invalid PRAGMA_SUMMARY_STATS_ADDRESS");

    let starknet_rpc = normalize_starknet_rpc_url(&config.starknet_rpc);
    let dark_pool_address = Felt::from_hex(&config.dark_pool_address).expect("Invalid DARK_POOL_ADDRESS");

    let state = AppState {
        storage,
        matcher,
        start_time: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
        api_config: config.api_config.clone(),
        starknet_rpc,
        pragma_summary_stats_address,
        pragma_oracle_address: Arc::new(OnceCell::new()),
        pragma_price_cache: Arc::new(RwLock::new(HashMap::new())),
        dark_pool_address,
        enforce_prechecks: config.enforce_prechecks,
    };

    let allow_any_origin = config.api_config.cors_origins.iter().any(|s| s.trim() == "*");

    let cors_public = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let cors_private = if allow_any_origin {
        CorsLayer::new()
            .allow_origin(Any)
            .allow_methods(Any)
            .allow_headers(Any)
    } else {
        let allowed_origins = config
            .api_config
            .cors_origins
            .into_iter()
            .filter_map(|origin| origin.parse().ok())
            .collect::<Vec<_>>();

        CorsLayer::new()
            .allow_origin(allowed_origins)
            .allow_methods(Any)
            .allow_headers(Any)
    };

    let public_routes = Router::new()
        .route("/v1/health", get(health_check))
        .route("/v1/starknet-rpc", post(starknet_rpc_proxy))
        .route("/v1/prices/pragma/twap", get(pragma_twap))
        .route("/health", get(health_check))
        .route("/starknet-rpc", post(starknet_rpc_proxy))
        .layer(cors_public);

    let private_routes = Router::new()
        .route("/v1/auth/login", post(login))
        .route("/v1/intents", post(submit_intent))
        .route("/v1/intents/:nullifier", get(query_intent))
        .route("/v1/intents/:nullifier/cancel", post(cancel_intent))
        .route("/v1/matches/:match_id/confirm", post(confirm_match))
        .route("/v1/intents/by-user", get(get_intents_by_user))
        .route("/v1/intents/pending", get(get_pending_intents))
        .route("/v1/stats", get(get_stats))
        .route("/auth/login", post(login))
        .route("/intent", post(submit_intent))
        .route("/intent/:nullifier", get(query_intent))
        .route("/intents/by-user", get(get_intents_by_user))
        .route("/intents/pending", get(get_pending_intents))
        .route("/stats", get(get_stats))
        .layer(cors_private);

    Router::new()
        .merge(public_routes)
        .merge(private_routes)
        .with_state(state)
}

#[derive(Debug, Deserialize)]
struct PragmaTwapQuery {
    pair_id: String,
    window_seconds: Option<u64>,
}

#[derive(Debug, Serialize, Clone)]
struct PragmaTwapResponse {
    success: bool,
    source: String,
    pair_id: String,
    window_seconds: u64,
    start_time: u64,
    price_raw: String,
    decimals_raw: String,
}

async fn pragma_twap(
    State(state): State<AppState>,
    Query(query): Query<PragmaTwapQuery>,
) -> ApiResult<JsonResponse<PragmaTwapResponse>> {
    fn felt_hex(v: Felt) -> String {
        format!("0x{:x}", v)
    }

    async fn jsonrpc_starknet_call(
        rpc_url: &str,
        contract_address: Felt,
        selector: Felt,
        calldata: Vec<Felt>,
    ) -> Result<serde_json::Value, reqwest::Error> {
        let payload = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "starknet_call",
            "params": [
                {
                    "contract_address": format!("0x{:x}", contract_address),
                    "entry_point_selector": format!("0x{:x}", selector),
                    "calldata": calldata.into_iter().map(|v| format!("0x{:x}", v)).collect::<Vec<_>>(),
                },
                // Some RPC providers are strict about BlockId encoding. "latest" (string) is widely accepted.
                "latest"
            ]
        });

        reqwest::Client::new().post(rpc_url).json(&payload).send().await?.json().await
    }

    let now = chrono::Utc::now().timestamp().max(0) as u64;
    let window_seconds = query.window_seconds.unwrap_or(3600).max(1).min(24 * 60 * 60);
    let start_time = now.saturating_sub(window_seconds);

    let pair_id = query.pair_id.trim().to_string();
    if pair_id.is_empty() || pair_id.len() > 31 {
        return Err((
            StatusCode::BAD_REQUEST,
            JsonResponse(error_response(
                "INVALID_PAIR_ID",
                "pair_id is required and must be <= 31 chars",
                None,
            )),
        ));
    }

    let pair_felt = cairo_short_string_to_felt(&pair_id).map_err(|_| {
        (
            StatusCode::BAD_REQUEST,
            JsonResponse(error_response(
                "INVALID_PAIR_ID",
                "pair_id must be a Cairo short string",
                None,
            )),
        )
    })?;

    // Serve cached response to avoid hammering the RPC/Pragma contracts (and spamming logs)
    // when the frontend recalculates slippage frequently.
    // Cache per (pair_id, window_seconds) for a short TTL.
    let cache_key = format!("{}:{}", pair_id, window_seconds);
    {
        let cache = state.pragma_price_cache.read().await;
        if let Some(entry) = cache.get(&cache_key) {
            if now < entry.expires_at {
                return Ok(JsonResponse(entry.response.clone()));
            }
        }
    }

    // Selector: calculate_twap
    let selector = get_selector_from_name("calculate_twap").map_err(|_| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            JsonResponse(error_response(
                "INTERNAL_ERROR",
                "Failed to build selector",
                None,
            )),
        )
    })?;

    // Send JSON-RPC directly to avoid client incompatibilities across providers.
    // Some testnets may not have enough checkpoints for TWAP; in that case we fall back to Pragma's spot median.
    let mut source = "pragma_twap".to_string();
    let json = jsonrpc_starknet_call(
        &state.starknet_rpc,
        state.pragma_summary_stats_address,
        selector,
        vec![
            // DataType::SpotEntry(pair_id)
            Felt::ZERO,
            pair_felt,
            // AggregationMode::Median(())
            Felt::ZERO,
            Felt::from(window_seconds),
            Felt::from(start_time),
        ],
    )
    .await
    .map_err(|e| {
        error!("Pragma TWAP RPC request failed: {}", e);
        (
            StatusCode::BAD_GATEWAY,
            JsonResponse(error_response(
                "PRAGMA_TWAP_ERROR",
                "Failed to reach Starknet RPC",
                None,
            )),
        )
    })?;

    fn is_not_enough_data_error(payload: &serde_json::Value) -> bool {
        // Pragma testnet TWAP often reverts with "Not enough data".
        // Treat that as a normal "TWAP unavailable" situation and fall back without error-level logging.
        payload
            .get("error")
            .and_then(|e| e.get("data"))
            .and_then(|d| d.get("revert_error"))
            .and_then(|re| re.get("error"))
            .and_then(|v| v.as_str())
            .map(|s| s.contains("Not enough data") || s.contains("0x4e6f7420656e6f7567682064617461"))
            .unwrap_or(false)
    }

    // If the TWAP call errors (e.g., "Not enough data" on testnets), try spot median from the oracle contract.
    let json = if json.get("error").is_some() {
        if is_not_enough_data_error(&json) {
            debug!("Pragma TWAP not available (Not enough data); falling back to spot median");
        } else {
            warn!("Pragma TWAP RPC returned error payload; falling back to spot median: {}", json);
        }

        let oracle_addr = *state
            .pragma_oracle_address
            .get_or_try_init(|| async {
                // get_oracle_address() -> ContractAddress
                let oracle_selector = get_selector_from_name("get_oracle_address").map_err(|_| {
                    anyhow::anyhow!("Failed to build selector")
                })?;
                let oracle_addr_json = jsonrpc_starknet_call(
                    &state.starknet_rpc,
                    state.pragma_summary_stats_address,
                    oracle_selector,
                    vec![],
                )
                .await
                .map_err(|e| anyhow::anyhow!("Pragma oracle address RPC request failed: {}", e))?;

                let oracle_addr = oracle_addr_json
                    .get("result")
                    .and_then(|v| v.as_array())
                    .and_then(|a| a.get(0))
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| anyhow::anyhow!("Failed to resolve Pragma oracle address"))?;

                let oracle_addr = Felt::from_hex(oracle_addr)
                    .map_err(|_| anyhow::anyhow!("Failed to parse Pragma oracle address"))?;
                Ok::<Felt, anyhow::Error>(oracle_addr)
            })
            .await
            .map_err(|e| {
                error!("{}", e);
                (
                    StatusCode::BAD_GATEWAY,
                    JsonResponse(error_response(
                        "PRAGMA_TWAP_ERROR",
                        "Failed to resolve Pragma oracle address",
                        None,
                    )),
                )
            })?;

        // get_data_median(DataType) -> PragmaPricesResponse
        let spot_selector = get_selector_from_name("get_data_median").map_err(|_| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                JsonResponse(error_response(
                    "INTERNAL_ERROR",
                    "Failed to build selector",
                    None,
                )),
            )
        })?;

        source = "pragma_spot_median".to_string();
        jsonrpc_starknet_call(
            &state.starknet_rpc,
            oracle_addr,
            spot_selector,
            vec![
                // DataType::SpotEntry(pair_id)
                Felt::ZERO,
                pair_felt,
            ],
        )
        .await
        .map_err(|e| {
            error!("Pragma spot median RPC request failed: {}", e);
            (
                StatusCode::BAD_GATEWAY,
                JsonResponse(error_response(
                    "PRAGMA_TWAP_ERROR",
                    "Failed to reach Starknet RPC",
                    None,
                )),
            )
        })?
    } else {
        json
    };

    let result = json
        .get("result")
        .and_then(|v| v.as_array())
        .ok_or_else(|| {
            (
                StatusCode::BAD_GATEWAY,
                JsonResponse(error_response(
                    "PRAGMA_TWAP_ERROR",
                    "TWAP response missing fields",
                    None,
                )),
            )
        })?;

    if result.len() < 2 {
        return Err((
            StatusCode::BAD_GATEWAY,
            JsonResponse(error_response(
                "PRAGMA_TWAP_ERROR",
                "TWAP response missing fields",
                None,
            )),
        ));
    }

    let price_raw = result[0].as_str().unwrap_or_default().to_string();
    let decimals_raw = result[1].as_str().unwrap_or_default().to_string();
    if price_raw.is_empty() || decimals_raw.is_empty() {
        return Err((
            StatusCode::BAD_GATEWAY,
            JsonResponse(error_response(
                "PRAGMA_TWAP_ERROR",
                "TWAP response missing fields",
                None,
            )),
        ));
    }

    let resp = PragmaTwapResponse {
        success: true,
        source,
        pair_id,
        window_seconds,
        start_time,
        price_raw,
        decimals_raw,
    };

    // Keep cache short to avoid stale prices while still reducing RPC pressure.
    {
        let ttl = 30u64;
        let mut cache = state.pragma_price_cache.write().await;
        cache.insert(
            cache_key,
            CachedPragmaPrice {
                expires_at: now.saturating_add(ttl),
                response: resp.clone(),
            },
        );
    }

    Ok(JsonResponse(resp))
}

async fn starknet_rpc_proxy(
    State(state): State<AppState>,
    Json(payload): Json<serde_json::Value>,
) -> Result<JsonResponse<serde_json::Value>, (StatusCode, JsonResponse<ErrorResponse>)> {
    // Allow browsers to call Starknet JSON-RPC without CORS issues by proxying through the solver.
    // We intentionally do not expose arbitrary URLs; only the configured STARKNET_RPC is used.
    let client = reqwest::Client::new();
    let resp = client
        .post(&state.starknet_rpc)
        .json(&payload)
        .send()
        .await
        .map_err(|e| {
            error!("RPC proxy request failed: {}", e);
            (
                StatusCode::BAD_GATEWAY,
                JsonResponse(error_response(
                    "RPC_PROXY_ERROR",
                    "Failed to reach Starknet RPC",
                    None,
                )),
            )
        })?;

    let status = resp.status();
    let json = resp.json::<serde_json::Value>().await.map_err(|e| {
        error!("RPC proxy JSON decode failed: {}", e);
        (
            StatusCode::BAD_GATEWAY,
            JsonResponse(error_response(
                "RPC_PROXY_ERROR",
                "Invalid response from Starknet RPC",
                None,
            )),
        )
    })?;

    if !status.is_success() {
        return Err((
            StatusCode::BAD_GATEWAY,
            JsonResponse(error_response(
                "RPC_PROXY_ERROR",
                "Starknet RPC returned an error",
                None,
            )),
        ));
    }

    Ok(JsonResponse(json))
}

async fn health_check(State(state): State<AppState>) -> JsonResponse<HealthResponse> {
    let stats = state.storage.get_stats().await.unwrap_or(SolverStats {
        pending_intents: 0,
        matched_pairs: 0,
    });
    let uptime = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs().saturating_sub(state.start_time))
        .unwrap_or(0);

    JsonResponse(HealthResponse {
        status: "healthy".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        uptime_seconds: uptime,
        pending_intents: stats.pending_intents,
        matched_pairs: stats.matched_pairs,
    })
}

async fn login(
    State(state): State<AppState>,
    Json(payload): Json<LoginRequest>,
) -> ApiResult<JsonResponse<LoginResponse>> {
    if payload.username != state.api_config.auth_username || payload.password != state.api_config.auth_password {
        return Err((
            StatusCode::UNAUTHORIZED,
            JsonResponse(error_response(
                "UNAUTHORIZED",
                "Invalid username or password",
                None,
            )),
        ));
    }

    let token = issue_token(
        &payload.username,
        &state.api_config.jwt_secret,
        (ACCESS_TOKEN_EXPIRES_SECONDS / 60) as i64,
    )
    .map_err(|e| {
        error!("Failed to issue access token: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            JsonResponse(error_response("AUTH_ERROR", "Failed to issue token", None)),
        )
    })?;

    Ok(JsonResponse(LoginResponse {
        success: true,
        token,
        expires_in_seconds: ACCESS_TOKEN_EXPIRES_SECONDS,
    }))
}

async fn submit_intent(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<SubmitIntentRequest>,
) -> ApiResult<JsonResponse<SubmitIntentResponse>> {
    let correlation_id = correlation_id_from_headers(&headers);
    require_auth(&headers, &state, &correlation_id)?;

    info!(
        "Received intent submission from user {}, correlation_id={}",
        request.public_inputs.user, correlation_id
    );

    if request.proof_data.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            JsonResponse(error_response(
                "INVALID_PROOF",
                "Invalid proof data (empty)",
                Some(correlation_id),
            )),
        ));
    }
    // Current Groth16 circuit uses nPublic=3 (VK IC length = 4).
    // Older payloads may include additional business fields; accept either as long as
    // minimum verifier-required public signals are present.
    if !request.proof_public_inputs.is_empty() && request.proof_public_inputs.len() < 3 {
        return Err((
            StatusCode::BAD_REQUEST,
            JsonResponse(error_response(
                "INVALID_PUBLIC_INPUTS",
                "Invalid proof_public_inputs (expected at least 3 elements)",
                Some(correlation_id),
            )),
        ));
    }
    if !is_valid_signature(&request.signature) {
        return Err((
            StatusCode::BAD_REQUEST,
            JsonResponse(error_response(
                "INVALID_SIGNATURE",
                "Signature format is invalid",
                Some(correlation_id),
            )),
        ));
    }
    if request.public_inputs.chain_id.trim().is_empty()
        || request.public_inputs.domain_separator.trim().is_empty()
    {
        return Err((
            StatusCode::BAD_REQUEST,
            JsonResponse(error_response(
                "INVALID_INTENT_METADATA",
                "chain_id and domain_separator are required",
                Some(correlation_id),
            )),
        ));
    }

    let now = chrono::Utc::now().timestamp().max(0) as u64;
    if request.public_inputs.deadline <= now {
        return Err((
            StatusCode::BAD_REQUEST,
            JsonResponse(error_response(
                "ERR_EXPIRED_INTENT",
                "Intent already expired",
                Some(correlation_id),
            )),
        ));
    }

    if state.enforce_prechecks {
        if let Err((status, body)) =
            enforce_balance_allowance_precheck(&state, &request, &correlation_id).await
        {
            return Err((status, JsonResponse(body)));
        }
    }

    if let Ok(Some(_)) = state.storage.get_intent(&request.nullifier).await {
        return Err((
            StatusCode::CONFLICT,
            JsonResponse(error_response(
                "DUPLICATE_INTENT",
                "Intent already exists",
                Some(correlation_id),
            )),
        ));
    }

    // Fail fast for invalid proofs by simulating DarkPool.submit_intent through RPC.
    // This prevents invalid intents from entering the matching queue and getting stuck in `Matched`.
    if let Err(reason) = preflight_verify_intent_proof(&state, &request).await {
        warn!(
            "Proof preflight verification failed: correlation_id={}, user={}, nullifier={}, reason={}",
            correlation_id,
            request.public_inputs.user,
            request.nullifier,
            reason
        );
        return Err((
            StatusCode::BAD_REQUEST,
            JsonResponse(error_response(
                "INVALID_PROOF",
                &format!("Proof preflight verification failed: {}", reason),
                Some(correlation_id),
            )),
        ));
    }

    match state
        .storage
        .reserve_nonce(
            &request.public_inputs.user,
            request.public_inputs.nonce,
            request.public_inputs.deadline,
        )
        .await
    {
        Ok(false) => {
            return Err((
                StatusCode::CONFLICT,
                JsonResponse(error_response(
                    "ERR_NONCE_REPLAY",
                    "Nonce already used",
                    Some(correlation_id),
                )),
            ));
        }
        Err(e) => {
            error!("Failed to reserve nonce: {}", e);
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                JsonResponse(error_response(
                    "STORAGE_ERROR",
                    "Failed to reserve nonce",
                    Some(correlation_id),
                )),
            ));
        }
        Ok(true) => {}
    }

    let encrypted_details = match base64::decode(&request.encrypted_details) {
        Ok(data) => data,
        Err(_) => {
            return Err((
                StatusCode::BAD_REQUEST,
                JsonResponse(error_response(
                    "INVALID_ENCODING",
                    "Invalid encrypted details",
                    Some(correlation_id),
                )),
            ));
        }
    };

    let expires_at = chrono::DateTime::<chrono::Utc>::from_timestamp(request.public_inputs.deadline as i64, 0)
        .ok_or_else(|| {
            (
                StatusCode::BAD_REQUEST,
                JsonResponse(error_response(
                    "INVALID_DEADLINE",
                    "Invalid deadline timestamp",
                    Some(correlation_id.clone()),
                )),
            )
        })?;

    let intent = Intent::new(
        request.intent_hash,
        request.nullifier.clone(),
        request.proof_data,
        request.proof_public_inputs,
        request.public_inputs,
        encrypted_details,
        expires_at,
    );

    if let Err(e) = state.storage.store_intent(&intent).await {
        error!("Failed to store intent: {}", e);
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            JsonResponse(error_response(
                "STORAGE_ERROR",
                "Failed to store intent",
                Some(correlation_id),
            )),
        ));
    }

    Ok(JsonResponse(SubmitIntentResponse {
        intent_id: intent.id,
        status: intent.status,
        estimated_match_time: Some("< 30 seconds".to_string()),
        correlation_id,
    }))
}

async fn preflight_verify_intent_proof(
    state: &AppState,
    request: &SubmitIntentRequest,
) -> Result<(), String> {
    fn parse_felt_any(input: &str) -> Result<Felt, String> {
        let v = input.trim();
        if v.is_empty() {
            return Err("empty felt".to_string());
        }
        if v.starts_with("0x") || v.starts_with("0X") {
            Felt::from_hex(v).map_err(|e| e.to_string())
        } else {
            Felt::from_dec_str(v).map_err(|e| e.to_string())
        }
    }
    fn parse_named_felt(name: &str, input: &str) -> Result<Felt, String> {
        parse_felt_any(input).map_err(|e| {
            let v = input.trim();
            let preview = if v.len() > 96 {
                format!("{}...", &v[..96])
            } else {
                v.to_string()
            };
            format!("{} parse error: {} (value={})", name, e, preview)
        })
    }

    let selector = get_selector_from_name("submit_intent").map_err(|e| e.to_string())?;
    let contract = state.dark_pool_address;

    // IntentProof ABI:
    // [intent_hash, nullifier, proof_data_len, ...proof_data, public_inputs_len, ...public_inputs]
    let mut calldata: Vec<Felt> = Vec::new();
    calldata.push(parse_named_felt("intent_hash", &request.intent_hash)?);
    calldata.push(parse_named_felt("nullifier", &request.nullifier)?);
    calldata.push(Felt::from(request.proof_data.len() as u64));
    for (idx, p) in request.proof_data.iter().enumerate() {
        calldata.push(parse_named_felt(&format!("proof_data[{}]", idx), p)?);
    }
    calldata.push(Felt::from(request.proof_public_inputs.len() as u64));
    for (idx, p) in request.proof_public_inputs.iter().enumerate() {
        calldata.push(parse_named_felt(&format!("proof_public_inputs[{}]", idx), p)?);
    }

    let payload = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "starknet_call",
        "params": [
            {
                "contract_address": format!("0x{:x}", contract),
                "entry_point_selector": format!("0x{:x}", selector),
                "calldata": calldata.into_iter().map(|v| format!("0x{:x}", v)).collect::<Vec<_>>(),
            },
            "latest"
        ]
    });

    let json: serde_json::Value = reqwest::Client::new()
        .post(&state.starknet_rpc)
        .json(&payload)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;

    if let Some(err) = json.get("error") {
        let msg = err
            .get("message")
            .and_then(|v| v.as_str())
            .map(ToString::to_string)
            .unwrap_or_else(|| err.to_string());
        return Err(msg);
    }

    Ok(())
}

async fn enforce_balance_allowance_precheck(
    state: &AppState,
    request: &SubmitIntentRequest,
    correlation_id: &str,
) -> Result<(), (StatusCode, ErrorResponse)> {
    async fn jsonrpc_starknet_call(
        rpc_url: &str,
        contract_address: Felt,
        selector: Felt,
        calldata: Vec<Felt>,
        block_tag: &'static str,
    ) -> Result<serde_json::Value, reqwest::Error> {
        let payload = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "starknet_call",
            "params": [
                {
                    "contract_address": format!("0x{:x}", contract_address),
                    "entry_point_selector": format!("0x{:x}", selector),
                    "calldata": calldata.into_iter().map(|v| format!("0x{:x}", v)).collect::<Vec<_>>(),
                },
                // Use "pending" so approvals/balances reflect mempool state faster.
                // This reduces "approve 2-3 times" UX issues due to provider propagation delays.
                block_tag
            ]
        });

        reqwest::Client::new().post(rpc_url).json(&payload).send().await?.json().await
    }

    async fn jsonrpc_starknet_call_best_effort(
        rpc_url: &str,
        contract_address: Felt,
        selector: Felt,
        calldata: Vec<Felt>,
    ) -> Result<serde_json::Value, reqwest::Error> {
        // Prefer "pending" so just-submitted approvals reflect faster.
        // If a provider rejects the block tag (e.g., "Invalid params"), fall back to "latest".
        let pending = jsonrpc_starknet_call(rpc_url, contract_address, selector, calldata.clone(), "pending").await?;
        let msg = pending
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(|m| m.as_str())
            .unwrap_or("");
        if msg.to_lowercase().contains("invalid params") || msg.contains("InvalidParams") {
            return jsonrpc_starknet_call(rpc_url, contract_address, selector, calldata, "latest").await;
        }
        Ok(pending)
    }

    fn jsonrpc_error_message(json: &serde_json::Value) -> Option<String> {
        let err = json.get("error")?;
        // Common shape: { "code": ..., "message": "...", "data": ... }
        if let Some(msg) = err.get("message").and_then(|v| v.as_str()) {
            return Some(msg.to_string());
        }
        Some(err.to_string())
    }

    fn parse_u256_like(value: &serde_json::Value) -> Option<(String, String)> {
        // Support a few observed shapes across providers:
        // 1) ["0xLOW", "0xHIGH"]
        // 2) ["0xLOW"] (assume HIGH=0)
        // 3) [{"low":"0x..","high":"0x.."}]
        // 4) [{"balance":{"low":"0x..","high":"0x.."}}]
        if let Some(arr) = value.as_array() {
            if arr.is_empty() {
                return None;
            }
            if arr.len() >= 2 && arr[0].is_string() && arr[1].is_string() {
                return Some((arr[0].as_str()?.to_string(), arr[1].as_str()?.to_string()));
            }
            if arr.len() == 1 && arr[0].is_string() {
                return Some((arr[0].as_str()?.to_string(), "0x0".to_string()));
            }
            if arr.len() >= 1 && arr[0].is_object() {
                let obj = arr[0].as_object()?;
                if let (Some(low), Some(high)) = (obj.get("low"), obj.get("high")) {
                    return Some((low.as_str()?.to_string(), high.as_str()?.to_string()));
                }
                if let Some(balance) = obj.get("balance").and_then(|v| v.as_object()) {
                    let low = balance.get("low")?.as_str()?.to_string();
                    let high = balance.get("high")?.as_str()?.to_string();
                    return Some((low, high));
                }
            }
            return None;
        }
        if let Some(obj) = value.as_object() {
            if let (Some(low), Some(high)) = (obj.get("low"), obj.get("high")) {
                return Some((low.as_str()?.to_string(), high.as_str()?.to_string()));
            }
            if let Some(balance) = obj.get("balance").and_then(|v| v.as_object()) {
                let low = balance.get("low")?.as_str()?.to_string();
                let high = balance.get("high")?.as_str()?.to_string();
                return Some((low, high));
            }
        }
        None
    }

    fn parse_u256_result(json: &serde_json::Value) -> Option<BigUint> {
        let result = json.get("result")?;
        let (low, high) = parse_u256_like(result)?;
        let low = BigUint::from_str_radix(low.trim_start_matches("0x"), 16).ok()?;
        let high = BigUint::from_str_radix(high.trim_start_matches("0x"), 16).ok()?;
        Some(low + (high << 128u32))
    }

    fn parse_felt_result(json: &serde_json::Value) -> Option<BigUint> {
        let result = json.get("result")?.as_array()?;
        let v = result.get(0)?.as_str()?;
        BigUint::from_str_radix(v.trim_start_matches("0x"), 16).ok()
    }

    fn parse_units_decimal(amount: &str, decimals: u32) -> Option<BigUint> {
        let s = amount.trim();
        if s.is_empty() {
            return None;
        }
        if s.starts_with('-') {
            return None;
        }

        let mut parts = s.splitn(2, '.');
        let int_part = parts.next().unwrap_or("0").trim();
        let frac_part = parts.next().unwrap_or("").trim();

        if !int_part.chars().all(|c| c.is_ascii_digit()) {
            return None;
        }
        if !frac_part.chars().all(|c| c.is_ascii_digit()) {
            return None;
        }

        let mut frac = frac_part.to_string();
        if frac.len() > decimals as usize {
            frac.truncate(decimals as usize);
        } else {
            while frac.len() < decimals as usize {
                frac.push('0');
            }
        }

        let digits = format!("{}{}", if int_part.is_empty() { "0" } else { int_part }, frac);
        let digits = digits.trim_start_matches('0');
        if digits.is_empty() {
            return Some(BigUint::from(0u8));
        }
        BigUint::from_str_radix(digits, 10).ok()
    }

    let token_addr = Felt::from_hex(&request.public_inputs.token_in).map_err(|_| {
        (
            StatusCode::BAD_REQUEST,
            error_response(
                "INVALID_TOKEN",
                "token_in must be a felt hex address",
                Some(correlation_id.to_string()),
            ),
        )
    })?;
    let user_addr = Felt::from_hex(&request.public_inputs.user).map_err(|_| {
        (
            StatusCode::BAD_REQUEST,
            error_response(
                "INVALID_USER",
                "user must be a felt hex address",
                Some(correlation_id.to_string()),
            ),
        )
    })?;

    let sel_decimals = get_selector_from_name("decimals").map_err(|_| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            error_response("INTERNAL_ERROR", "Failed to build selector", Some(correlation_id.to_string())),
        )
    })?;
    let sel_balance = get_selector_from_name("balanceOf").map_err(|_| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            error_response("INTERNAL_ERROR", "Failed to build selector", Some(correlation_id.to_string())),
        )
    })?;
    let sel_allowance = get_selector_from_name("allowance").map_err(|_| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            error_response("INTERNAL_ERROR", "Failed to build selector", Some(correlation_id.to_string())),
        )
    })?;

    let decimals_json = jsonrpc_starknet_call_best_effort(&state.starknet_rpc, token_addr, sel_decimals, vec![])
        .await
        .map_err(|e| {
            error!("Precheck decimals RPC failed: {}", e);
            (
                StatusCode::BAD_GATEWAY,
                error_response(
                    "PRECHECK_RPC_ERROR",
                    "Failed to query token decimals",
                    Some(correlation_id.to_string()),
                ),
            )
        })?;
    if let Some(msg) = jsonrpc_error_message(&decimals_json) {
        error!("Precheck decimals JSON-RPC error: {}", msg);
        return Err((
            StatusCode::BAD_GATEWAY,
            error_response(
                "PRECHECK_RPC_ERROR",
                "Failed to query token decimals",
                Some(correlation_id.to_string()),
            ),
        ));
    }
    let decimals = parse_felt_result(&decimals_json).ok_or_else(|| {
        (
            StatusCode::BAD_GATEWAY,
            error_response(
                "PRECHECK_RPC_ERROR",
                "Token decimals response missing fields",
                Some(correlation_id.to_string()),
            ),
        )
    })?;
    let decimals_u32: u32 = decimals.to_u32().unwrap_or(18);

    let required = parse_units_decimal(&request.public_inputs.amount_in, decimals_u32).ok_or_else(|| {
        (
            StatusCode::BAD_REQUEST,
            error_response(
                "INVALID_AMOUNT",
                "amount_in must be a non-negative decimal string",
                Some(correlation_id.to_string()),
            ),
        )
    })?;

    let bal_json = jsonrpc_starknet_call_best_effort(
        &state.starknet_rpc,
        token_addr,
        sel_balance,
        vec![user_addr],
    )
    .await
    .map_err(|e| {
        error!("Precheck balanceOf RPC failed: {}", e);
        (
            StatusCode::BAD_GATEWAY,
            error_response(
                "PRECHECK_RPC_ERROR",
                "Failed to query token balance",
                Some(correlation_id.to_string()),
            ),
        )
    })?;
    if let Some(msg) = jsonrpc_error_message(&bal_json) {
        error!("Precheck balanceOf JSON-RPC error: {}", msg);
        return Err((
            StatusCode::BAD_GATEWAY,
            error_response(
                "PRECHECK_RPC_ERROR",
                "Failed to query token balance",
                Some(correlation_id.to_string()),
            ),
        ));
    }
    let balance = parse_u256_result(&bal_json).ok_or_else(|| {
        (
            StatusCode::BAD_GATEWAY,
            error_response(
                "PRECHECK_RPC_ERROR",
                "Token balance response missing fields",
                Some(correlation_id.to_string()),
            ),
        )
    })?;

    if balance < required {
        return Err((
            StatusCode::BAD_REQUEST,
            error_response(
                "INSUFFICIENT_BALANCE",
                "Insufficient token balance for amount_in",
                Some(correlation_id.to_string()),
            ),
        ));
    }

    let allowance_json = jsonrpc_starknet_call_best_effort(
        &state.starknet_rpc,
        token_addr,
        sel_allowance,
        vec![user_addr, state.dark_pool_address],
    )
    .await
    .map_err(|e| {
        error!("Precheck allowance RPC failed: {}", e);
        (
            StatusCode::BAD_GATEWAY,
            error_response(
                "PRECHECK_RPC_ERROR",
                "Failed to query token allowance",
                Some(correlation_id.to_string()),
            ),
        )
    })?;
    if let Some(msg) = jsonrpc_error_message(&allowance_json) {
        error!("Precheck allowance JSON-RPC error: {}", msg);
        return Err((
            StatusCode::BAD_GATEWAY,
            error_response(
                "PRECHECK_RPC_ERROR",
                "Failed to query token allowance",
                Some(correlation_id.to_string()),
            ),
        ));
    }
    let allowance = parse_u256_result(&allowance_json).ok_or_else(|| {
        (
            StatusCode::BAD_GATEWAY,
            error_response(
                "PRECHECK_RPC_ERROR",
                "Token allowance response missing fields",
                Some(correlation_id.to_string()),
            ),
        )
    })?;

    if allowance < required {
        return Err((
            StatusCode::BAD_REQUEST,
            error_response(
                "INSUFFICIENT_ALLOWANCE",
                "Insufficient token allowance for amount_in",
                Some(correlation_id.to_string()),
            ),
        ));
    }

    Ok(())
}

async fn query_intent(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(nullifier): Path<String>,
) -> ApiResult<JsonResponse<QueryIntentResponse>> {
    let correlation_id = correlation_id_from_headers(&headers);
    require_auth(&headers, &state, &correlation_id)?;

    match state.storage.get_intent(&nullifier).await {
        Ok(Some(intent)) => {
            let view = IntentView {
                id: intent.id,
                nullifier: intent.nullifier,
                user: intent.public_inputs.user,
                status: intent.status,
                created_at: intent.created_at,
                expires_at: intent.expires_at,
                matched_with: intent.matched_with,
                settlement_tx_hash: intent.settlement_tx_hash,
            };
            Ok(JsonResponse(QueryIntentResponse { intent: Some(view) }))
        }
        Ok(None) => Ok(JsonResponse(QueryIntentResponse { intent: None })),
        Err(e) => {
            error!("Failed to query intent: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                JsonResponse(error_response(
                    "QUERY_ERROR",
                    "Failed to query intent",
                    Some(correlation_id),
                )),
            ))
        }
    }
}

async fn cancel_intent(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(nullifier): Path<String>,
) -> ApiResult<JsonResponse<ActionResponse>> {
    let correlation_id = correlation_id_from_headers(&headers);
    require_auth(&headers, &state, &correlation_id)?;

    let intent = state.storage.get_intent(&nullifier).await.map_err(|e| {
        error!("Failed to fetch intent for cancel: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            JsonResponse(error_response(
                "QUERY_ERROR",
                "Failed to fetch intent",
                Some(correlation_id.clone()),
            )),
        )
    })?;

    let intent = intent.ok_or_else(|| {
        (
            StatusCode::NOT_FOUND,
            JsonResponse(error_response(
                "NOT_FOUND",
                "Intent not found",
                Some(correlation_id.clone()),
            )),
        )
    })?;

    if intent.status != IntentStatus::Pending {
        return Err((
            StatusCode::CONFLICT,
            JsonResponse(error_response(
                "INVALID_STATE",
                "Only pending intents can be cancelled",
                Some(correlation_id),
            )),
        ));
    }

    state
        .storage
        .update_intent_status(&nullifier, IntentStatus::Cancelled, None, None)
        .await
        .map_err(|e| {
            error!("Failed to cancel intent: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                JsonResponse(error_response(
                    "STORAGE_ERROR",
                    "Failed to cancel intent",
                    Some(correlation_id.clone()),
                )),
            )
        })?;

    Ok(JsonResponse(ActionResponse {
        success: true,
        correlation_id,
        message: "Intent cancelled".to_string(),
    }))
}

async fn confirm_match(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(match_id): Path<String>,
) -> ApiResult<JsonResponse<ActionResponse>> {
    let correlation_id = correlation_id_from_headers(&headers);
    require_auth(&headers, &state, &correlation_id)?;

    state
        .matcher
        .settle_match_by_id(&match_id)
        .await
        .map_err(|e| {
            let msg = e.to_string();
            error!("Failed to settle match {}: {}", match_id, msg);

            // Surface precheck failures as explicit, user-actionable errors.
            let (code, user_message) = if msg.contains("INSUFFICIENT_ALLOWANCE") {
                (
                    "INSUFFICIENT_ALLOWANCE",
                    "Insufficient token allowance for settlement. Please approve the Dark Pool contract and try again.",
                )
            } else if msg.contains("INSUFFICIENT_BALANCE") {
                (
                    "INSUFFICIENT_BALANCE",
                    "Insufficient token balance for settlement. Please top up and try again.",
                )
            } else {
                ("SETTLEMENT_ERROR", "Failed to settle match")
            };

            (
                StatusCode::BAD_REQUEST,
                JsonResponse(error_response(code, user_message, Some(correlation_id.clone()))),
            )
        })?;

    Ok(JsonResponse(ActionResponse {
        success: true,
        correlation_id,
        message: "Match confirmed and settlement submitted".to_string(),
    }))
}

async fn get_pending_intents(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::extract::Query(query): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> ApiResult<JsonResponse<Vec<IntentView>>> {
    let correlation_id = correlation_id_from_headers(&headers);
    require_auth(&headers, &state, &correlation_id)?;

    match state.storage.get_pending_intents().await {
        Ok(intents) => {
            // Wallets / libraries sometimes return the same Starknet address with different
            // zero-padding. Compare by felt value when possible to avoid false mismatches.
            let user_filter_raw = query.get("user").map(|v| v.trim().to_string());
            let user_filter_felt = user_filter_raw
                .as_deref()
                .and_then(|v| (!v.trim().is_empty()).then_some(v))
                .and_then(|v| Felt::from_hex(v).ok());
            let user_filter_lc = user_filter_raw
                .as_deref()
                .map(|v| v.trim().to_lowercase())
                .filter(|v| !v.is_empty());

            let views: Vec<IntentView> = intents
                .into_iter()
                .filter(|intent| {
                    if let Some(user_felt) = user_filter_felt {
                        if let Ok(intent_user_felt) = Felt::from_hex(intent.public_inputs.user.trim()) {
                            return intent_user_felt == user_felt;
                        }
                        // Fall back to string compare if parsing fails.
                    }
                    if let Some(ref user_lc) = user_filter_lc {
                        return intent.public_inputs.user.trim().to_lowercase() == *user_lc;
                    }
                    true
                })
                .map(|intent| IntentView {
                    id: intent.id,
                    nullifier: intent.nullifier,
                    user: intent.public_inputs.user,
                    status: intent.status,
                    created_at: intent.created_at,
                    expires_at: intent.expires_at,
                    matched_with: intent.matched_with,
                    settlement_tx_hash: intent.settlement_tx_hash,
                })
                .collect();
            Ok(JsonResponse(views))
        }
        Err(e) => {
            error!("Failed to get pending intents: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                JsonResponse(error_response(
                    "QUERY_ERROR",
                    "Failed to get pending intents",
                    Some(correlation_id),
                )),
            ))
        }
    }
}

async fn get_intents_by_user(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::extract::Query(query): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> ApiResult<JsonResponse<Vec<IntentView>>> {
    let correlation_id = correlation_id_from_headers(&headers);
    require_auth(&headers, &state, &correlation_id)?;

    let user = query
        .get("user")
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .ok_or_else(|| {
            (
                StatusCode::BAD_REQUEST,
                JsonResponse(error_response(
                    "INVALID_REQUEST",
                    "Missing user query parameter",
                    Some(correlation_id.clone()),
                )),
            )
        })?;

    match state.storage.get_intents_by_user(&user).await {
        Ok(mut intents) => {
            // Compatibility: older deployments may have intents in `intents:pending` but no per-user index.
            // If the index is empty, fall back to scanning pending and filtering by user felt value.
            if intents.is_empty() {
                if let Ok(pending) = state.storage.get_pending_intents().await {
                    let user_felt = Felt::from_hex(user.trim()).ok();
                    intents = pending
                        .into_iter()
                        .filter(|intent| {
                            if let (Some(a), Ok(b)) = (user_felt, Felt::from_hex(intent.public_inputs.user.trim())) {
                                a == b
                            } else {
                                intent.public_inputs.user.trim().eq_ignore_ascii_case(user.trim())
                            }
                        })
                        .collect();
                }
            }

            let mut views: Vec<IntentView> = intents
                .into_iter()
                .map(|intent| IntentView {
                    id: intent.id,
                    nullifier: intent.nullifier,
                    user: intent.public_inputs.user,
                    status: intent.status,
                    created_at: intent.created_at,
                    expires_at: intent.expires_at,
                    matched_with: intent.matched_with,
                    settlement_tx_hash: intent.settlement_tx_hash,
                })
                .collect();
            views.sort_by(|a, b| b.created_at.cmp(&a.created_at));
            Ok(JsonResponse(views))
        }
        Err(e) => {
            error!("Failed to get intents by user: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                JsonResponse(error_response(
                    "QUERY_ERROR",
                    "Failed to get intents",
                    Some(correlation_id),
                )),
            ))
        }
    }
}

async fn get_stats(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> ApiResult<JsonResponse<SolverStats>> {
    let correlation_id = correlation_id_from_headers(&headers);
    require_auth(&headers, &state, &correlation_id)?;

    match state.storage.get_stats().await {
        Ok(stats) => Ok(JsonResponse(stats)),
        Err(e) => {
            error!("Failed to get stats: {}", e);
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                JsonResponse(error_response(
                    "STATS_ERROR",
                    "Failed to get statistics",
                    Some(correlation_id),
                )),
            ))
        }
    }
}

fn require_auth(
    headers: &HeaderMap,
    state: &AppState,
    correlation_id: &str,
) -> ApiResult<String> {
    // Allow turning auth off for demo deployments where the UI is public.
    // When disabled, all protected endpoints are treated as publicly accessible.
    if !state.api_config.require_auth {
        return Ok("public".to_string());
    }

    let token = bearer_token_from_headers(headers).ok_or_else(|| {
        (
            StatusCode::UNAUTHORIZED,
            JsonResponse(error_response(
                "UNAUTHORIZED",
                "Missing bearer token",
                Some(correlation_id.to_string()),
            )),
        )
    })?;

    let claims = verify_token(token, &state.api_config.jwt_secret).map_err(|_| {
        (
            StatusCode::UNAUTHORIZED,
            JsonResponse(error_response(
                "UNAUTHORIZED",
                "Invalid or expired bearer token",
                Some(correlation_id.to_string()),
            )),
        )
    })?;

    Ok(claims.sub)
}

fn bearer_token_from_headers(headers: &HeaderMap) -> Option<&str> {
    let value = headers.get("authorization")?.to_str().ok()?;
    value.strip_prefix("Bearer ").map(str::trim)
}

fn is_valid_signature(signature: &str) -> bool {
    let trimmed = signature.trim();
    if !trimmed.starts_with("0x") || trimmed.len() < 66 {
        return false;
    }
    trimmed
        .trim_start_matches("0x")
        .chars()
        .all(|ch| ch.is_ascii_hexdigit())
}

fn correlation_id_from_headers(headers: &HeaderMap) -> String {
    headers
        .get("x-correlation-id")
        .and_then(|v| v.to_str().ok())
        .filter(|v| !v.trim().is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string())
}

fn error_response(code: &str, message: &str, correlation_id: Option<String>) -> ErrorResponse {
    ErrorResponse {
        success: false,
        error: message.to_string(),
        code: code.to_string(),
        error_detail: ErrorDetail {
            code: code.to_string(),
            message: message.to_string(),
        },
        correlation_id,
    }
}
