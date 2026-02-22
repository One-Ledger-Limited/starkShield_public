use anyhow::Result;
use std::sync::Arc;
use tracing::{info, debug, warn, error};
use tokio::time::{interval, Duration};
use num_bigint::BigUint;
use std::str::FromStr;

use crate::config::MatchingConfig;
use crate::models::{Intent, IntentStatus, MatchedPair, SettlementData};
use crate::storage::RedisStorage;
use crate::starknet::StarknetClient;
use crate::starknet::{parse_amount_to_base_units, token_decimals_for};

pub struct IntentMatcher {
    storage: Arc<RedisStorage>,
    config: MatchingConfig,
    starknet: Option<Arc<StarknetClient>>,
    auto_settle_onchain: bool,
}

impl IntentMatcher {
    fn amounts_in_base_units(intent: &Intent) -> Option<(BigUint, BigUint)> {
        // Prefer prover-supplied base-unit values:
        // [user, tokenIn, tokenOut, amountIn, minAmountOut, deadline]
        if intent.proof_public_inputs.len() >= 5 {
            let amount_in = BigUint::from_str(&intent.proof_public_inputs[3]).ok()?;
            let min_out = BigUint::from_str(&intent.proof_public_inputs[4]).ok()?;
            return Some((amount_in, min_out));
        }

        // Backward compatibility for older intents without proof_public_inputs.
        let in_decimals = token_decimals_for(&intent.public_inputs.token_in);
        let out_decimals = token_decimals_for(&intent.public_inputs.token_out);
        let amount_in = parse_amount_to_base_units(&intent.public_inputs.amount_in, in_decimals).ok()?;
        let min_out = parse_amount_to_base_units(&intent.public_inputs.min_amount_out, out_decimals).ok()?;
        Some((amount_in, min_out))
    }

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
        let settle_every_ticks: u64 = (10_000u64 / self.config.poll_interval_ms.max(1)).max(1);
        let mut ticks: u64 = 0;
        
        info!("Starting intent matching loop");
        
        loop {
            ticker.tick().await;
            ticks = ticks.wrapping_add(1);
            
            if let Err(e) = self.match_batch().await {
                error!("Error in matching batch: {}", e);
            }

            // Retry settlement for already-matched pairs (e.g., allowance hasn't propagated yet).
            // Throttle to avoid hammering the RPC provider every poll tick.
            if self.auto_settle_onchain && (ticks % settle_every_ticks == 0) {
                if let Err(e) = self.retry_unsettled_matches().await {
                    warn!("Error retrying unsettled matches: {}", e);
                }
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
        
        // Check amount compatibility in base units.
        // A's input should satisfy B's minimum output, and vice versa.
        let (amount_a_in, min_a_out) = match Self::amounts_in_base_units(a) {
            Some(v) => v,
            None => return false,
        };
        let (amount_b_in, min_b_out) = match Self::amounts_in_base_units(b) {
            Some(v) => v,
            None => return false,
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
        // Calculate surplus using base units, convert to f64 for ranking only.
        let (amount_a_in, min_a_out) = Self::amounts_in_base_units(a).unwrap_or_default();
        let (amount_b_in, min_b_out) = Self::amounts_in_base_units(b).unwrap_or_default();
        
        let surplus_a = if amount_a_in >= min_b_out {
            &amount_a_in - &min_b_out
        } else {
            BigUint::from(0u32)
        };
        
        let surplus_b = if amount_b_in >= min_a_out {
            &amount_b_in - &min_a_out
        } else {
            BigUint::from(0u32)
        };
        
        // Convert to f64 for sorting (precision loss acceptable for ranking)
        let total_surplus = surplus_a + surplus_b;
        total_surplus.to_string().parse::<f64>().unwrap_or(0.0)
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

            // Best-effort on-chain precheck to avoid submitting a settlement tx that will revert
            // (most commonly due to insufficient balance/allowance).
            if let Err(reason) = self.precheck_settlement(client, &matched_pair).await {
                warn!(
                    "Skipping auto-settlement for match {} due to precheck failure: {}",
                    matched_pair.id, reason
                );
                return Ok(());
            }

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
                    self.storage.mark_match_settled(&matched_pair.id).await?;
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
            // Avoid submitting a tx that is guaranteed to revert due to missing approvals/balances.
            if let Err(reason) = self.precheck_settlement(client, &pair).await {
                return Err(anyhow::anyhow!(reason));
            }
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
            // Remove from the "matched" set so the retry loop doesn't keep attempting it.
            self.storage.mark_match_settled(&pair.id).await?;
            // If this was previously failing (e.g., allowance propagation), clear backoff state.
            let _ = self.storage.clear_match_retry_state(&pair.id).await;
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

    async fn retry_unsettled_matches(&self) -> Result<()> {
        if self.starknet.is_none() {
            return Ok(());
        }

        let pairs = self.storage.get_unsettled_matches().await?;
        if pairs.is_empty() {
            return Ok(());
        }

        debug!("Retrying settlement for {} matched pairs", pairs.len());

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();

        let is_funding_error = |msg: &str| {
            msg.contains("INSUFFICIENT_BALANCE") || msg.contains("INSUFFICIENT_ALLOWANCE")
        };

        // Backoff after 3 consecutive failures:
        // 3 -> 5m, 4 -> 10m, 5 -> 20m ... capped at 1h.
        let compute_backoff_secs = |failures: u64| -> u64 {
            if failures < 3 {
                return 0;
            }
            let exp = (failures - 3).min(6);
            (300u64).saturating_mul(1u64 << exp).min(3600)
        };

        for pair in pairs {
            if let Ok(Some(state)) = self.storage.get_match_retry_state(&pair.id).await {
                if state.next_retry_at_unix > now {
                    debug!(
                        "Skipping retry for match {} until {} (failures={})",
                        pair.id, state.next_retry_at_unix, state.failures
                    );
                    continue;
                }
            }

            // `settle_match` already runs the precheck, so this is safe to attempt.
            if let Err(e) = self.settle_match(pair.clone()).await {
                // Common case: allowances haven't updated yet. Keep it in the set for the next retry.
                let msg = e.to_string();
                if is_funding_error(&msg) {
                    let current_failures = self
                        .storage
                        .get_match_retry_state(&pair.id)
                        .await
                        .ok()
                        .flatten()
                        .map(|s| s.failures)
                        .unwrap_or(0);
                    let next_failures = current_failures + 1;
                    let backoff = compute_backoff_secs(next_failures);
                    let next_retry_at_unix = now.saturating_add(backoff);
                    let _ = self.storage.bump_match_retry_state(&pair.id, next_retry_at_unix).await;
                    if backoff > 0 {
                        debug!(
                            "Backoff enabled for match {} after {} failures; next retry in {}s",
                            pair.id, next_failures, backoff
                        );
                    }
                }
                debug!("Retry settlement skipped/failed: {}", msg);
            } else {
                let _ = self.storage.clear_match_retry_state(&pair.id).await;
            }
        }

        Ok(())
    }

    async fn precheck_settlement(&self, client: &Arc<StarknetClient>, pair: &MatchedPair) -> Result<(), String> {
        // Check both users have enough balance and allowance for their token_in.
        // Spender for transfer_from is the DarkPool contract itself.
        let spender = client.dark_pool_address();

        let a = &pair.intent_a.public_inputs;
        let b = &pair.intent_b.public_inputs;

        let a_decimals = token_decimals_for(&a.token_in);
        let b_decimals = token_decimals_for(&b.token_in);
        let a_required = parse_amount_to_base_units(&a.amount_in, a_decimals).map_err(|e| e.to_string())?;
        let b_required = parse_amount_to_base_units(&b.amount_in, b_decimals).map_err(|e| e.to_string())?;

        let a_bal = client.erc20_balance_of(&a.token_in, &a.user).await.map_err(|e| e.to_string())?;
        let a_allow = client.erc20_allowance(&a.token_in, &a.user, spender).await.map_err(|e| e.to_string())?;
        if a_bal < a_required {
            return Err(format!(
                "INSUFFICIENT_BALANCE user={} token_in={} balance={} required={}",
                a.user, a.token_in, a_bal, a_required
            ));
        }
        if a_allow < a_required {
            return Err(format!(
                "INSUFFICIENT_ALLOWANCE user={} token_in={} allowance={} required={} spender=0x{:x}",
                a.user, a.token_in, a_allow, a_required, spender
            ));
        }

        let b_bal = client.erc20_balance_of(&b.token_in, &b.user).await.map_err(|e| e.to_string())?;
        let b_allow = client.erc20_allowance(&b.token_in, &b.user, spender).await.map_err(|e| e.to_string())?;
        if b_bal < b_required {
            return Err(format!(
                "INSUFFICIENT_BALANCE user={} token_in={} balance={} required={}",
                b.user, b.token_in, b_bal, b_required
            ));
        }
        if b_allow < b_required {
            return Err(format!(
                "INSUFFICIENT_ALLOWANCE user={} token_in={} allowance={} required={} spender=0x{:x}",
                b.user, b.token_in, b_allow, b_required, spender
            ));
        }

        Ok(())
    }
}
