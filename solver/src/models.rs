use serde::{Deserialize, Serialize};
use chrono::{DateTime, Utc};
use uuid::Uuid;

/// Represents an encrypted trade intent submitted by a user
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Intent {
    pub id: String,
    pub intent_hash: String,
    pub nullifier: String,
    pub proof_data: Vec<String>,
    pub public_inputs: PublicInputs,
    pub encrypted_details: Vec<u8>, // Encrypted intent details
    pub status: IntentStatus,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub matched_with: Option<String>,
    pub settlement_tx_hash: Option<String>,
}

/// Public inputs that are visible without decrypting the intent
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PublicInputs {
    pub user: String,
    pub token_in: String,
    pub token_out: String,
    pub amount_in: String,
    pub min_amount_out: String,
    pub deadline: u64,
    pub nonce: u64,
    pub chain_id: String,
    pub domain_separator: String,
    pub version: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum IntentStatus {
    Pending,
    Matched,
    Settled,
    Cancelled,
    Expired,
    Failed,
}

/// A matched pair of intents ready for settlement
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MatchedPair {
    pub id: String,
    pub intent_a: Intent,
    pub intent_b: Intent,
    pub matched_at: DateTime<Utc>,
    pub expected_profit: f64,
    pub settlement_data: SettlementData,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SettlementData {
    pub ekubo_pool: String,
    pub sqrt_price_limit: String,
}

/// Request to submit a new intent
#[derive(Debug, Deserialize)]
pub struct SubmitIntentRequest {
    pub intent_hash: String,
    pub nullifier: String,
    pub proof_data: Vec<String>,
    pub public_inputs: PublicInputs,
    pub encrypted_details: String, // base64 encoded
    pub signature: String,
}

/// Response for intent submission
#[derive(Debug, Serialize)]
pub struct SubmitIntentResponse {
    pub intent_id: String,
    pub status: IntentStatus,
    pub estimated_match_time: Option<String>,
    pub correlation_id: String,
}

/// Request to query intent status
#[derive(Debug, Deserialize)]
pub struct QueryIntentRequest {
    pub nullifier: String,
}

#[derive(Debug, Serialize)]
pub struct QueryIntentResponse {
    pub intent: Option<IntentView>,
}

#[derive(Debug, Serialize)]
pub struct ActionResponse {
    pub success: bool,
    pub correlation_id: String,
    pub message: String,
}

#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    pub username: String,
    pub password: String,
}

#[derive(Debug, Serialize)]
pub struct LoginResponse {
    pub success: bool,
    pub token: String,
    pub expires_in_seconds: u64,
}

#[derive(Debug, Serialize)]
pub struct IntentView {
    pub id: String,
    pub nullifier: String,
    pub user: String,
    pub status: IntentStatus,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub matched_with: Option<String>,
    pub settlement_tx_hash: Option<String>,
}

/// Health check response
#[derive(Debug, Serialize)]
pub struct HealthResponse {
    pub status: String,
    pub version: String,
    pub uptime_seconds: u64,
    pub pending_intents: usize,
    pub matched_pairs: usize,
}

/// Error response
#[derive(Debug, Serialize)]
pub struct ErrorResponse {
    pub success: bool,
    pub error: String,
    pub code: String,
    pub error_detail: ErrorDetail,
    pub correlation_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ErrorDetail {
    pub code: String,
    pub message: String,
}

impl Intent {
    pub fn new(
        intent_hash: String,
        nullifier: String,
        proof_data: Vec<String>,
        public_inputs: PublicInputs,
        encrypted_details: Vec<u8>,
        expires_at: DateTime<Utc>,
    ) -> Self {
        let now = Utc::now();
        Self {
            id: Uuid::new_v4().to_string(),
            intent_hash,
            nullifier,
            proof_data,
            public_inputs,
            encrypted_details,
            status: IntentStatus::Pending,
            created_at: now,
            expires_at,
            matched_with: None,
            settlement_tx_hash: None,
        }
    }

    pub fn is_expired(&self) -> bool {
        Utc::now() > self.expires_at
    }

    pub fn can_match(&self) -> bool {
        self.status == IntentStatus::Pending && !self.is_expired()
    }
}

impl MatchedPair {
    pub fn new(intent_a: Intent, intent_b: Intent, settlement_data: SettlementData) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            matched_at: Utc::now(),
            expected_profit: 0.0, // TODO: Calculate based on spread
            settlement_data,
            intent_a,
            intent_b,
        }
    }
}
