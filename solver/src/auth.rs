use anyhow::{anyhow, Result};
use chrono::{Duration, Utc};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JwtClaims {
    pub sub: String,
    pub iat: usize,
    pub exp: usize,
}

pub fn issue_token(subject: &str, jwt_secret: &str, expires_minutes: i64) -> Result<String> {
    let now = Utc::now();
    let exp = now + Duration::minutes(expires_minutes);
    let claims = JwtClaims {
        sub: subject.to_string(),
        iat: now.timestamp().max(0) as usize,
        exp: exp.timestamp().max(0) as usize,
    };

    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(jwt_secret.as_bytes()),
    )
    .map_err(|e| anyhow!("failed to issue token: {}", e))
}

pub fn verify_token(token: &str, jwt_secret: &str) -> Result<JwtClaims> {
    let token_data = decode::<JwtClaims>(
        token,
        &DecodingKey::from_secret(jwt_secret.as_bytes()),
        &Validation::default(),
    )
    .map_err(|e| anyhow!("invalid token: {}", e))?;
    Ok(token_data.claims)
}
