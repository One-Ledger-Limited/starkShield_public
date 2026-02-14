use anyhow::Result;
use std::sync::Arc;
use tracing::{info, debug, warn, error};
use tokio::time::{interval, Duration};

use crate::config::MatchingConfig;
use crate::models::{Intent, IntentStatus, MatchedPair, SettlementData};
use crate::storage::RedisStorage;
use crate::starknet::StarknetClient;

pub struct IntentMatcher {
    storage: Arc<RedisStorage>,
    config: MatchingConfig,
    starknet: Option<Arc<StarknetClient>>,
    auto_settle_onchain: bool,
}

impl IntentMatcher {
    pub fn new(
        storage: Arc<RedisStorage>,
        config: MatchingConfig,
        starknet: Option<Arc<StarknetClient>>,
        auto_settle_onchain: bool,
    ) -> Self {
        Self { storage, config, starknet, auto_settle_onchain }
    }

    /// Main matching loop - runs continuously
    pub async fn run_matching_loop(&self) {
        let mut ticker = interval(Duration::from_millis(self.config.poll_interval_ms));
        
        info!("Starting intent matching loop");
        
        loop {
            ticker.tick().await;
            
            if let Err(e) = self.match_batch().await {
                error!("Error in matching batch: {}", e);
            }
        }
    }

    /// Process a batch of intents for matching
    async fn match_batch(&self) -> Result<()> {
        let mut pending = self.storage.get_pending_intents().await?;
        pending.sort_by(|a, b| {
            a.created_at
                .cmp(&b.created_at)
                .then_with(|| a.nullifier.cmp(&b.nullifier))
        });
        
        if pending.is_empty() {
            return Ok(());
        }
        
        debug!("Processing {} pending intents", pending.len());
        
        // Group intents by token pair
        let mut pairs: Vec<(String, String)> = pending
            .iter()
            .map(|i| (i.public_inputs.token_in.clone(), i.public_inputs.token_out.clone()))
            .collect();
        
        pairs.sort();
        pairs.dedup();
        
        // Try to find matches for each pair.
        // Matching is deterministic: intents are processed in stable time order and
        // the best compatible counterparty (highest surplus, then earliest created_at)
        // is selected.
        for (token_a, token_b) in pairs {
            // Look for complementary pairs (A->B and B->A)
            let mut intents_a = self.storage.get_intents_by_pair(&token_a, &token_b).await?;
            let mut intents_b = self.storage.get_intents_by_pair(&token_b, &token_a).await?;

            if intents_a.is_empty() || intents_b.is_empty() {
                continue;
            }

            intents_a.sort_by(|a, b| {
                a.created_at
                    .cmp(&b.created_at)
                    .then_with(|| a.nullifier.cmp(&b.nullifier))
            });
            intents_b.sort_by(|a, b| {
                a.created_at
                    .cmp(&b.created_at)
                    .then_with(|| a.nullifier.cmp(&b.nullifier))
            });

            let mut used_b = std::collections::HashSet::new();

            // Try to find compatible matches
            for intent_a in &intents_a {
                if !intent_a.can_match() {
                    continue;
                }
                let best = intents_b
                    .iter()
                    .enumerate()
                    .filter(|(idx, b)| !used_b.contains(idx) && self.are_compatible(intent_a, b))
                    .max_by(|(_, b1), (_, b2)| {
                        self.compatibility_surplus(intent_a, b1)
                            .partial_cmp(&self.compatibility_surplus(intent_a, b2))
                            .unwrap_or(std::cmp::Ordering::Equal)
                            .then_with(|| b2.created_at.cmp(&b1.created_at))
                            .then_with(|| b2.nullifier.cmp(&b1.nullifier))
                    });

                if let Some((idx, intent_b)) = best {
                    match self.create_match(intent_a.clone(), intent_b.clone()).await {
                        Ok(_) => {
                            used_b.insert(idx);
                            info!(
                                "Matched intents {} <-> {}",
                                intent_a.nullifier,
                                intent_b.nullifier
                            );
                        }
                        Err(e) => {
                            warn!("Failed to create match: {}", e);
                        }
                    }
                }
            }
        }
        
        Ok(())
    }

    /// Check if two intents are compatible for matching
    fn are_compatible(&self, a: &Intent, b: &Intent) -> bool {
        // Same user cannot match with themselves
        if a.public_inputs.user == b.public_inputs.user {
            return false;
        }
        
        // Tokens must be complementary
        if a.public_inputs.token_in != b.public_inputs.token_out
            || a.public_inputs.token_out != b.public_inputs.token_in
        {
            return false;
        }
        
        // Check amount compatibility
        // A's input should satisfy B's minimum output
        let amount_a_in = match a.public_inputs.amount_in.parse::<f64>() {
            Ok(v) => v,
            Err(_) => return false,
        };
        
        let min_b_out = match b.public_inputs.min_amount_out.parse::<f64>() {
            Ok(v) => v,
            Err(_) => return false,
        };
        
        let amount_b_in = match b.public_inputs.amount_in.parse::<f64>() {
            Ok(v) => v,
            Err(_) => return false,
        };
        
        let min_a_out = match a.public_inputs.min_amount_out.parse::<f64>() {
            Ok(v) => v,
            Err(_) => return false,
        };
        
        // Both sides must be satisfied
        if amount_a_in < min_b_out || amount_b_in < min_a_out {
            return false;
        }
        
        // Check deadline compatibility - both must not be expired
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        
        if a.public_inputs.deadline < now || b.public_inputs.deadline < now {
            return false;
        }
        
        true
    }

    fn compatibility_surplus(&self, a: &Intent, b: &Intent) -> f64 {
        let amount_a_in = a.public_inputs.amount_in.parse::<f64>().unwrap_or(0.0);
        let min_b_out = b.public_inputs.min_amount_out.parse::<f64>().unwrap_or(0.0);
        let amount_b_in = b.public_inputs.amount_in.parse::<f64>().unwrap_or(0.0);
        let min_a_out = a.public_inputs.min_amount_out.parse::<f64>().unwrap_or(0.0);
        (amount_a_in - min_b_out) + (amount_b_in - min_a_out)
    }

    /// Create a match between two compatible intents
    async fn create_match(&self, intent_a: Intent, intent_b: Intent) -> Result<()> {
        // Verify both intents are still pending
        if !intent_a.can_match() || !intent_b.can_match() {
            return Err(anyhow::anyhow!("One or more intents no longer pending"));
        }
        
        // Create settlement data
        let settlement_data = SettlementData {
            ekubo_pool: self.get_pool_address(&intent_a.public_inputs.token_in, &intent_a.public_inputs.token_out),
            sqrt_price_limit: "0".to_string(), // TODO: Calculate from current price
        };
        
        let matched_pair = MatchedPair::new(intent_a.clone(), intent_b.clone(), settlement_data);
        
        // Store the match
        self.storage.store_matched_pair(&matched_pair).await?;
        
        // Update intent statuses
        self.storage.update_intent_status(
            &intent_a.nullifier,
            IntentStatus::Matched,
            Some(intent_b.nullifier.clone()),
            None,
        ).await?;
        
        self.storage.update_intent_status(
            &intent_b.nullifier,
            IntentStatus::Matched,
            Some(intent_a.nullifier.clone()),
            None,
        ).await?;

        // Auto-settle on-chain immediately after match creation.
        // This requires the solver account to be configured and funded.
        if self.auto_settle_onchain {
            let client = self
                .starknet
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("AUTO_SETTLE_ONCHAIN enabled but Starknet client is not configured"))?;

            match client.settle_match(&matched_pair).await {
                Ok(tx_hash) => {
                    self.storage.update_intent_status(
                        &intent_a.nullifier,
                        IntentStatus::Settled,
                        Some(intent_b.nullifier.clone()),
                        Some(tx_hash.clone()),
                    ).await?;
                    self.storage.update_intent_status(
                        &intent_b.nullifier,
                        IntentStatus::Settled,
                        Some(intent_a.nullifier.clone()),
                        Some(tx_hash),
                    ).await?;
                    info!("Auto-settled match {} on-chain", matched_pair.id);
                }
                Err(e) => {
                    error!("Auto-settlement failed for match {}: {}", matched_pair.id, e);
                    // Keep status as Matched so it can be retried manually later via confirm endpoint.
                }
            }
        }

        Ok(())
    }

    /// Settle a match by id (called by confirm endpoint).
    pub async fn settle_match_by_id(&self, match_id: &str) -> Result<()> {
        let pair = self
            .storage
            .get_matched_pair(match_id)
            .await?
            .ok_or_else(|| anyhow::anyhow!("Match not found: {}", match_id))?;
        self.settle_match(pair).await
    }

    /// Settle a matched pair on-chain
    async fn settle_match(&self, pair: MatchedPair) -> Result<()> {
        info!(
            "Settling match {}: {} <-> {}",
            pair.id,
            pair.intent_a.nullifier,
            pair.intent_b.nullifier
        );
        
        if let Some(client) = &self.starknet {
            let tx_hash = client.settle_match(&pair).await?;
            self.storage.update_intent_status(
                &pair.intent_a.nullifier,
                IntentStatus::Settled,
                Some(pair.intent_b.nullifier.clone()),
                Some(tx_hash.clone()),
            ).await?;
            self.storage.update_intent_status(
                &pair.intent_b.nullifier,
                IntentStatus::Settled,
                Some(pair.intent_a.nullifier.clone()),
                Some(tx_hash),
            ).await?;
            info!("Match {} settled successfully", pair.id);
            Ok(())
        } else {
            Err(anyhow::anyhow!("Starknet client not configured"))
        }
    }

    /// Get pool address from token pair
    fn get_pool_address(&self, token_a: &str, token_b: &str) -> String {
        // In production, this would query Ekubo factory
        // For now, return a deterministic mock address
        let parse = |token: &str| -> u64 {
            let raw = token.strip_prefix("0x").unwrap_or(token);
            let part = &raw[..raw.len().min(8)];
            u64::from_str_radix(part, 16).unwrap_or(0)
        };
        format!(
            "0x{:064x}",
            parse(token_a) ^ parse(token_b)
        )
    }
}
