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
        let mut conn = self.connection.write().await;
        
        let pair_ids: Vec<String> = redis::cmd("SMEMBERS")
            .arg("intents:matched")
            .query_async(&mut *conn)
            .await?;
        
        let mut pairs = Vec::new();
        for id in pair_ids {
            let key = format!("matched:{}", id);
            if let Ok(Some(value)) = redis::cmd("GET")
                .arg(&key)
                .query_async::<_, Option<String>>(&mut *conn)
                .await 
            {
                if let Ok(pair) = serde_json::from_str::<MatchedPair>(&value) {
                    if pair.intent_a.status != IntentStatus::Settled {
                        pairs.push(pair);
                    }
                }
            }
        }
        
        Ok(pairs)
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
