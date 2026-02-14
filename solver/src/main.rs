use anyhow::Result;
use tracing::{info, error};
use std::sync::Arc;

mod config;
mod models;
mod storage;
mod matcher;
mod api;
mod auth;
mod starknet;
mod utils;

use config::Config;
use storage::RedisStorage;
use matcher::IntentMatcher;
use api::create_router;
use starknet::StarknetClient;

#[tokio::main]
async fn main() -> Result<()> {
    // Initialize tracing
    tracing_subscriber::fmt()
        .with_env_filter("info,solver=debug")
        .init();

    info!("Starting StarkShield Solver...");

    // Load configuration
    let config = Config::from_env()?;
    info!("Configuration loaded successfully");

    // Initialize Redis storage
    let storage = Arc::new(RedisStorage::new(&config.redis_url).await?);
    info!("Connected to Redis");

    // Initialize Starknet settlement client (requires a funded solver account).
    // If misconfigured, keep solver running (matching/status still works) and allow manual troubleshooting.
    let starknet_client: Option<Arc<StarknetClient>> = if config.auto_settle_onchain {
        match &config.solver_address {
            Some(addr) => Some(Arc::new(StarknetClient::new(
                &config.starknet_rpc,
                &config.dark_pool_address,
                addr,
                &config.solver_private_key,
            ).await?)),
            None => {
                tracing::warn!("AUTO_SETTLE_ONCHAIN=true but SOLVER_ADDRESS is not set; auto settlement disabled");
                None
            }
        }
    } else {
        None
    };

    // Initialize intent matcher
    let matcher = Arc::new(IntentMatcher::new(
        storage.clone(),
        config.matching_config.clone(),
        starknet_client,
        config.auto_settle_onchain,
    ));
    info!("Intent matcher initialized");

    // Start background matching task
    let matcher_clone = matcher.clone();
    tokio::spawn(async move {
        matcher_clone.run_matching_loop().await;
    });

    // Create and start API server
    let app = create_router(storage, matcher, config.clone());
    let listener = tokio::net::TcpListener::bind(&config.server_addr).await?;
    
    info!("Solver listening on {}", config.server_addr);
    
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    info!("Solver shutdown complete");
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("Failed to install Ctrl+C handler");
    };

    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("Failed to install signal handler")
            .recv()
            .await;
    };

    tokio::select! {
        _ = ctrl_c => info!("Received Ctrl+C"),
        _ = terminate => info!("Received SIGTERM"),
    }
    
    info!("Shutting down...");
}
