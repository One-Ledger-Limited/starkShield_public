use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::env;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    pub server_addr: String,
    pub redis_url: String,
    pub starknet_rpc: String,
    pub dark_pool_address: String,
    pub solver_address: Option<String>,
    pub solver_private_key: String,
    pub auto_settle_onchain: bool,
    pub matching_config: MatchingConfig,
    pub api_config: ApiConfig,
    pub enforce_prechecks: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MatchingConfig {
    pub min_match_amount_usd: f64,
    pub max_slippage_bps: u16,
    pub match_timeout_seconds: u64,
    pub batch_size: usize,
    pub poll_interval_ms: u64,
    pub max_invalid_proof_retries: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiConfig {
    pub max_intent_size_bytes: usize,
    pub rate_limit_requests_per_minute: u32,
    pub cors_origins: Vec<String>,
    pub require_auth: bool,
    pub jwt_secret: String,
    pub auth_username: String,
    pub auth_password: String,
}

impl Config {
    pub fn from_env() -> Result<Self> {
        // Optional local dev support; in production we rely on env vars.
        dotenvy::dotenv().ok();

        let require_auth = env::var("REQUIRE_AUTH")
            .ok()
            .map(|v| matches!(v.trim().to_lowercase().as_str(), "1" | "true" | "yes" | "on"))
            .unwrap_or(true);

        let jwt_secret = match env::var("JWT_SECRET") {
            Ok(v) if !v.trim().is_empty() => v,
            _ if require_auth => {
                return Err(anyhow::anyhow!(
                    "JWT_SECRET must be set when REQUIRE_AUTH=true (do not use a hardcoded default in production)"
                ))
            }
            _ => String::new(),
        };

        let auth_password = match env::var("AUTH_PASSWORD") {
            Ok(v) if !v.trim().is_empty() => v,
            _ if require_auth => {
                return Err(anyhow::anyhow!(
                    "AUTH_PASSWORD must be set when REQUIRE_AUTH=true (do not ship demo passwords)"
                ))
            }
            _ => String::new(),
        };

        Ok(Config {
            server_addr: env::var("SOLVER_ADDR")
                .unwrap_or_else(|_| "0.0.0.0:8080".to_string()),
            redis_url: env::var("REDIS_URL")
                .unwrap_or_else(|_| "redis://localhost:6379".to_string()),
            starknet_rpc: env::var("STARKNET_RPC")
                .unwrap_or_else(|_| "https://starknet-sepolia.public.blastapi.io/rpc/v0_8".to_string()),
            dark_pool_address: env::var("DARK_POOL_ADDRESS")
                .map_err(|_| anyhow::anyhow!("DARK_POOL_ADDRESS must be set"))?,
            solver_address: env::var("SOLVER_ADDRESS")
                .ok()
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty()),
            solver_private_key: env::var("SOLVER_PRIVATE_KEY")
                .map_err(|_| anyhow::anyhow!("SOLVER_PRIVATE_KEY must be set"))?,
            auto_settle_onchain: env::var("AUTO_SETTLE_ONCHAIN")
                .ok()
                .map(|v| matches!(v.trim().to_lowercase().as_str(), "1" | "true" | "yes" | "on"))
                .unwrap_or(false),
            matching_config: MatchingConfig {
                min_match_amount_usd: env::var("MIN_MATCH_AMOUNT_USD")
                    .ok()
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(100.0),
                max_slippage_bps: env::var("MAX_SLIPPAGE_BPS")
                    .ok()
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(50),
                match_timeout_seconds: env::var("MATCH_TIMEOUT_SECONDS")
                    .ok()
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(300),
                batch_size: env::var("BATCH_SIZE")
                    .ok()
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(10),
                poll_interval_ms: env::var("POLL_INTERVAL_MS")
                    .ok()
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(1000),
                max_invalid_proof_retries: env::var("MAX_INVALID_PROOF_RETRIES")
                    .ok()
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(5),
            },
            api_config: ApiConfig {
                max_intent_size_bytes: env::var("MAX_INTENT_SIZE_BYTES")
                    .ok()
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(1024 * 1024), // 1MB
                rate_limit_requests_per_minute: env::var("RATE_LIMIT_RPM")
                    .ok()
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(60),
                cors_origins: env::var("CORS_ORIGINS")
                    .unwrap_or_else(|_| "http://localhost:5173".to_string())
                    .split(',')
                    .map(|s| s.trim().to_string())
                    .collect(),
                require_auth,
                jwt_secret,
                auth_username: env::var("AUTH_USERNAME")
                    .unwrap_or_else(|_| "admin".to_string()),
                auth_password,
            },
            enforce_prechecks: env::var("ENFORCE_PRECHECKS")
                .ok()
                .map(|v| matches!(v.trim().to_lowercase().as_str(), "1" | "true" | "yes" | "on"))
                .unwrap_or(false),
        })
    }
}
