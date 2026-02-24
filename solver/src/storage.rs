use anyhow::Result;
use redis::AsyncCommands;
use serde::Serialize;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{info, debug};

use crate::models::{Intent, IntentStatus, MatchedPair};

pub struct RedisStorage {
    connection: Arc<RwLock<redis::aio::ConnectionManager>>,
}

#[derive(Debug, Clone, Copy)]
pub struct MatchRetryState {
    pub failures: u64,
    pub next_retry_at_unix: u64,
    pub terminal: bool,
}

impl RedisStorage {
    fn user_index_key(user: &str) -> String {
        // Canonicalize by felt value when possible (removes padding/casing differences).
        // Fall back to lowercase string to avoid losing the intent.
        if let Ok(felt) = starknet::core::types::Felt::from_hex(user.trim()) {
            return format!("intents:user:0x{:x}", felt);
        }
        format!("intents:user:{}", user.trim().to_lowercase())
    }

    pub async fn new(redis_url: &str) -> Result<Self> {
        let client = redis::Client::open(redis_url)?;
        let connection = client.get_connection_manager().await?;
        
        info!("Connected to Redis at {}", redis_url);
        
        Ok(Self {
            connection: Arc::new(RwLock::new(connection)),
        })
    }

    fn match_retry_key(match_id: &str) -> String {
        format!("match:retry:{}", match_id)
    }

    /// Returns retry backoff state for a match id (if any).
    pub async fn get_match_retry_state(&self, match_id: &str) -> Result<Option<MatchRetryState>> {
        let key = Self::match_retry_key(match_id);
        let mut conn = self.connection.write().await;
        let failures: Option<u64> = redis::cmd("HGET")
            .arg(&key)
            .arg("failures")
            .query_async(&mut *conn)
            .await?;
        let next_retry_at_unix: Option<u64> = redis::cmd("HGET")
            .arg(&key)
            .arg("next_retry_at_unix")
            .query_async(&mut *conn)
            .await?;

        if failures.is_none() && next_retry_at_unix.is_none() {
            return Ok(None);
        }

        let terminal: Option<u8> = redis::cmd("HGET")
            .arg(&key)
            .arg("terminal")
            .query_async(&mut *conn)
            .await?;

        Ok(Some(MatchRetryState {
            failures: failures.unwrap_or(0),
            next_retry_at_unix: next_retry_at_unix.unwrap_or(0),
            terminal: terminal.unwrap_or(0) == 1,
        }))
    }

    /// Increments the failure counter and sets the next retry timestamp. Returns updated state.
    pub async fn bump_match_retry_state(&self, match_id: &str, next_retry_at_unix: u64) -> Result<MatchRetryState> {
        let key = Self::match_retry_key(match_id);
        let mut conn = self.connection.write().await;

        let failures: i64 = redis::cmd("HINCRBY")
            .arg(&key)
            .arg("failures")
            .arg(1)
            .query_async(&mut *conn)
            .await?;

        redis::cmd("HSET")
            .arg(&key)
            .arg("next_retry_at_unix")
            .arg(next_retry_at_unix)
            .query_async::<_, ()>(&mut *conn)
            .await?;
        redis::cmd("HDEL")
            .arg(&key)
            .arg("terminal")
            .arg("terminal_reason")
            .query_async::<_, ()>(&mut *conn)
            .await?;

        // Avoid leaking keys forever.
        let _ = redis::cmd("EXPIRE")
            .arg(&key)
            .arg(7 * 24 * 60 * 60) // 7 days
            .query_async::<_, ()>(&mut *conn)
            .await;

        Ok(MatchRetryState {
            failures: failures.max(0) as u64,
            next_retry_at_unix,
            terminal: false,
        })
    }

    /// Marks retry state as terminal (do not retry automatically anymore).
    pub async fn mark_match_retry_terminal(&self, match_id: &str, reason: &str) -> Result<MatchRetryState> {
        let key = Self::match_retry_key(match_id);
        let mut conn = self.connection.write().await;

        let failures: Option<u64> = redis::cmd("HGET")
            .arg(&key)
            .arg("failures")
            .query_async(&mut *conn)
            .await?;
        let failures = failures.unwrap_or(0);

        redis::cmd("HSET")
            .arg(&key)
            .arg("terminal")
            .arg(1)
            .arg("terminal_reason")
            .arg(reason)
            .arg("next_retry_at_unix")
            .arg(0)
            .query_async::<_, ()>(&mut *conn)
            .await?;

        let _ = redis::cmd("EXPIRE")
            .arg(&key)
            .arg(7 * 24 * 60 * 60) // 7 days
            .query_async::<_, ()>(&mut *conn)
            .await;

        Ok(MatchRetryState {
            failures,
            next_retry_at_unix: 0,
            terminal: true,
        })
    }

    /// Clears retry state for a match id (best-effort).
    pub async fn clear_match_retry_state(&self, match_id: &str) -> Result<()> {
        let key = Self::match_retry_key(match_id);
        let mut conn = self.connection.write().await;
        redis::cmd("DEL")
            .arg(&key)
            .query_async::<_, ()>(&mut *conn)
            .await?;
        Ok(())
    }

    /// Store a new intent
    pub async fn store_intent(&self, intent: &Intent) -> Result<()> {
        let key = format!("intent:{}", intent.nullifier);
        let value = serde_json::to_string(intent)?;
        
        let mut conn = self.connection.write().await;
        
        // Store intent with expiration
        let ttl = (intent.expires_at - intent.created_at).num_seconds().max(1) as u64;
        redis::cmd("SETEX")
            .arg(&key)
            .arg(ttl)
            .arg(&value)
            .query_async::<_, ()>(&mut *conn)
            .await?;
        
        // Add to pending set
        redis::cmd("SADD")
            .arg("intents:pending")
            .arg(&intent.nullifier)
            .query_async::<_, ()>(&mut *conn)
            .await?;

        // Index by user for status queries across devices/browsers.
        let user_key = Self::user_index_key(&intent.public_inputs.user);
        redis::cmd("SADD")
            .arg(&user_key)
            .arg(&intent.nullifier)
            .query_async::<_, ()>(&mut *conn)
            .await?;
        
        // Index by token pair
        let pair_key = format!("intents:pair:{}:{}", intent.public_inputs.token_in, intent.public_inputs.token_out);
        redis::cmd("SADD")
            .arg(&pair_key)
            .arg(&intent.nullifier)
            .query_async::<_, ()>(&mut *conn)
            .await?;
        
        debug!("Stored intent {} with TTL {}s", intent.nullifier, ttl);
        Ok(())
    }

    /// Reserve (user, nonce) for anti-replay. Returns false if already used.
    pub async fn reserve_nonce(
        &self,
        user: &str,
        nonce: u64,
        expires_at_unix: u64,
    ) -> Result<bool> {
        let key = format!("nonce:{}:{}", user, nonce);
        let now = chrono::Utc::now().timestamp().max(0) as u64;
        let ttl = expires_at_unix.saturating_sub(now).max(1);
        let mut conn = self.connection.write().await;
        let response: Option<String> = redis::cmd("SET")
            .arg(&key)
            .arg("1")
            .arg("NX")
            .arg("EX")
            .arg(ttl)
            .query_async(&mut *conn)
            .await?;
        Ok(response.is_some())
    }

    /// Get an intent by nullifier
    pub async fn get_intent(&self, nullifier: &str) -> Result<Option<Intent>> {
        let key = format!("intent:{}", nullifier);
        let mut conn = self.connection.write().await;
        
        let value: Option<String> = redis::cmd("GET")
            .arg(&key)
            .query_async(&mut *conn)
            .await?;
        
        match value {
            Some(json) => {
                let intent: Intent = serde_json::from_str(&json)?;
                Ok(Some(intent))
            }
            None => Ok(None),
        }
    }

    /// Get all pending intents
    pub async fn get_pending_intents(&self) -> Result<Vec<Intent>> {
        // Fetch nullifiers first, then resolve intents without holding the connection lock.
        // Holding the lock and calling `self.get_intent()` would deadlock (nested lock acquire).
        let nullifiers: Vec<String> = {
            let mut conn = self.connection.write().await;
            redis::cmd("SMEMBERS")
                .arg("intents:pending")
                .query_async(&mut *conn)
                .await?
        };

        let mut intents = Vec::new();
        for nullifier in nullifiers {
            if let Some(intent) = self.get_intent(&nullifier).await? {
                if intent.can_match() {
                    intents.push(intent);
                }
            }
        }
        
        Ok(intents)
    }

    /// Get pending intents for a specific token pair
    pub async fn get_intents_by_pair(&self, token_in: &str, token_out: &str) -> Result<Vec<Intent>> {
        let pair_key = format!("intents:pair:{}:{}", token_in, token_out);
        let nullifiers: Vec<String> = {
            let mut conn = self.connection.write().await;
            redis::cmd("SMEMBERS")
                .arg(&pair_key)
                .query_async(&mut *conn)
                .await?
        };

        let mut intents = Vec::new();
        for nullifier in nullifiers {
            if let Some(intent) = self.get_intent(&nullifier).await? {
                if intent.can_match() {
                    intents.push(intent);
                }
            }
        }
        
        Ok(intents)
    }

    /// Get intents for a specific user (all statuses)
    pub async fn get_intents_by_user(&self, user: &str) -> Result<Vec<Intent>> {
        let user_key = Self::user_index_key(user);
        let nullifiers: Vec<String> = {
            let mut conn = self.connection.write().await;
            redis::cmd("SMEMBERS")
                .arg(&user_key)
                .query_async(&mut *conn)
                .await?
        };

        let mut intents = Vec::new();
        for nullifier in nullifiers {
            if let Some(intent) = self.get_intent(&nullifier).await? {
                intents.push(intent);
            }
        }

        Ok(intents)
    }

    /// Update intent status
    pub async fn update_intent_status(
        &self,
        nullifier: &str,
        status: IntentStatus,
        matched_with: Option<String>,
        settlement_tx_hash: Option<String>,
    ) -> Result<()> {
        let mut intent = match self.get_intent(nullifier).await? {
            Some(intent) => intent,
            None => return Err(anyhow::anyhow!("Intent not found: {}", nullifier)),
        };
        
        intent.status = status.clone();
        intent.matched_with = matched_with;
        intent.settlement_tx_hash = settlement_tx_hash;
        
        let key = format!("intent:{}", nullifier);
        let value = serde_json::to_string(&intent)?;
        
        let mut conn = self.connection.write().await;
        redis::cmd("SET")
            .arg(&key)
            .arg(&value)
            .query_async::<_, ()>(&mut *conn)
            .await?;
        
        // Update pending set
        if status == IntentStatus::Matched || status == IntentStatus::Settled {
            redis::cmd("SREM")
                .arg("intents:pending")
                .arg(nullifier)
                .query_async::<_, ()>(&mut *conn)
                .await?;
        }
        
        debug!("Updated intent {} status to {:?}", nullifier, status);
        Ok(())
    }

    /// Store a matched pair
    pub async fn store_matched_pair(&self, pair: &MatchedPair) -> Result<()> {
        let key = format!("matched:{}", pair.id);
        let value = serde_json::to_string(pair)?;
        
        let mut conn = self.connection.write().await;
        redis::cmd("SET")
            .arg(&key)
            .arg(&value)
            .query_async::<_, ()>(&mut *conn)
            .await?;
        
        // Add to matched set
        redis::cmd("SADD")
            .arg("intents:matched")
            .arg(&pair.id)
            .query_async::<_, ()>(&mut *conn)
            .await?;
        
        debug!("Stored matched pair {}", pair.id);
        Ok(())
    }

    pub async fn get_matched_pair(&self, id: &str) -> Result<Option<MatchedPair>> {
        let key = format!("matched:{}", id);
        let mut conn = self.connection.write().await;
        let value: Option<String> = redis::cmd("GET")
            .arg(&key)
            .query_async(&mut *conn)
            .await?;
        match value {
            Some(json) => Ok(Some(serde_json::from_str(&json)?)),
            None => Ok(None),
        }
    }

    /// Get matched pairs awaiting settlement
    pub async fn get_unsettled_matches(&self) -> Result<Vec<MatchedPair>> {
        // Fetch matched pair ids without holding the lock, then resolve pair + intent status
        // using the normal helpers (avoids nested lock deadlocks).
        let pair_ids: Vec<String> = {
            let mut conn = self.connection.write().await;
            redis::cmd("SMEMBERS")
                .arg("intents:matched")
                .query_async(&mut *conn)
                .await?
        };

        let mut pairs = Vec::new();
        for id in pair_ids {
            let Some(pair) = self.get_matched_pair(&id).await? else {
                // Stale set member.
                let _ = self.mark_match_settled(&id).await;
                continue;
            };

            let a = self.get_intent(&pair.intent_a.nullifier).await?;
            let b = self.get_intent(&pair.intent_b.nullifier).await?;

            // Only retry when both sides are still in Matched state.
            match (a, b) {
                (Some(a), Some(b))
                    if a.status == IntentStatus::Matched
                        && b.status == IntentStatus::Matched
                        && a.settlement_tx_hash.is_none()
                        && b.settlement_tx_hash.is_none() =>
                {
                    pairs.push(pair);
                }
                _ => {
                    // Already settled/cancelled/expired or missing: clean up the set member.
                    let _ = self.mark_match_settled(&id).await;
                }
            }
        }

        Ok(pairs)
    }

    pub async fn mark_match_settled(&self, match_id: &str) -> Result<()> {
        let mut conn = self.connection.write().await;
        let key = format!("matched:{}", match_id);
        redis::cmd("SREM")
            .arg("intents:matched")
            .arg(match_id)
            .query_async::<_, ()>(&mut *conn)
            .await?;
        // Also delete the matched pair payload to avoid stale "matched" views.
        redis::cmd("DEL")
            .arg(&key)
            .query_async::<_, ()>(&mut *conn)
            .await?;
        Ok(())
    }

    /// Get solver statistics
    pub async fn get_stats(&self) -> Result<SolverStats> {
        let mut conn = self.connection.write().await;
        
        let pending: i64 = redis::cmd("SCARD")
            .arg("intents:pending")
            .query_async(&mut *conn)
            .await?;
        
        let matched: i64 = redis::cmd("SCARD")
            .arg("intents:matched")
            .query_async(&mut *conn)
            .await?;
        
        Ok(SolverStats {
            pending_intents: pending as usize,
            matched_pairs: matched as usize,
        })
    }
}

#[derive(Debug, Serialize)]
pub struct SolverStats {
    pub pending_intents: usize,
    pub matched_pairs: usize,
}
