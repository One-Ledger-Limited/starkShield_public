use starknet::{
    accounts::{Account, ExecutionEncoding, SingleOwnerAccount},
    core::types::{BlockId, BlockTag, Call, Felt, FunctionCall},
    core::utils::get_selector_from_name,
    providers::{jsonrpc::HttpTransport, JsonRpcClient, Provider},
    signers::{LocalWallet, SigningKey},
};
use anyhow::Result;
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::info;

use crate::models::MatchedPair;
use num_bigint::BigUint;
use num_traits::Num;

pub struct StarknetClient {
    provider: Arc<JsonRpcClient<HttpTransport>>,
    account: Arc<SingleOwnerAccount<Arc<JsonRpcClient<HttpTransport>>, LocalWallet>>,
    dark_pool_address: Felt,
    // Ensure we never submit two txs concurrently from the same solver account, which can
    // lead to duplicate nonces (and NonceTooOld errors) under load.
    tx_mutex: Mutex<()>,
    // Cached next nonce (best-effort). We always serialize sends via tx_mutex.
    next_nonce: Mutex<Option<Felt>>,
}

impl StarknetClient {
    pub async fn new(
        rpc_url: &str,
        dark_pool_address: &str,
        solver_address: &str,
        private_key: &str,
    ) -> Result<Self> {
        let provider = Arc::new(JsonRpcClient::new(HttpTransport::new(
            reqwest::Url::parse(rpc_url)?,
        )));

        let signer = LocalWallet::from(SigningKey::from_secret_scalar(
            felt_from_hex(private_key)?,
        ));

        // Get chain ID
        let chain_id = provider.chain_id().await?;

        // Use the deployed solver account address (must match SOLVER_PRIVATE_KEY).
        let address = felt_from_hex(solver_address)?;

        let account = Arc::new(SingleOwnerAccount::new(
            provider.clone(),
            signer,
            address,
            chain_id,
            ExecutionEncoding::New,
        ));

        let dark_pool = felt_from_hex(dark_pool_address)?;

        Ok(Self {
            provider,
            account,
            dark_pool_address: dark_pool,
            tx_mutex: Mutex::new(()),
            next_nonce: Mutex::new(None),
        })
    }

    async fn nonce_for_send(&self) -> Result<Felt> {
        // We serialize tx submission via tx_mutex, so we can safely reuse a cached nonce.
        // Important: do not advance the cache until a tx is successfully submitted.
        let mut guard = self.next_nonce.lock().await;
        if let Some(n) = *guard {
            return Ok(n);
        }

        // Use Latest since this starknet-rs version doesn't expose a Pending tag in BlockId/BlockTag.
        let onchain = self
            .provider
            .get_nonce(BlockId::Tag(BlockTag::Latest), self.account.address())
            .await?;
        *guard = Some(onchain);
        Ok(onchain)
    }

    async fn mark_nonce_used(&self, used: Felt) {
        let mut guard = self.next_nonce.lock().await;
        *guard = Some(used + Felt::from(1u8));
    }

    async fn reset_nonce_cache(&self) {
        let mut guard = self.next_nonce.lock().await;
        *guard = None;
    }

    async fn seed_nonce_cache(&self, nonce: Felt) {
        let mut guard = self.next_nonce.lock().await;
        *guard = Some(nonce);
    }

    /// Settle a matched pair on-chain
    pub async fn settle_match(&self, pair: &MatchedPair) -> Result<String> {
        info!(
            "Settling match {} on Starknet",
            pair.id
        );

        // Cairo ABI encoding for:
        // settle_match(intent_a: IntentProof, intent_b: IntentProof, settlement_data: SettlementData)
        //
        // IntentProof = { intent_hash, nullifier, proof_data: Array<felt252>, public_inputs: Array<felt252> }
        // SettlementData = { ekubo_pool: ContractAddress, sqrt_price_limit: u256(low, high) }
        let mut calldata: Vec<Felt> = Vec::new();
        append_intent_proof(&mut calldata, &pair.intent_a)?;
        append_intent_proof(&mut calldata, &pair.intent_b)?;

        // Settlement data
        calldata.push(parse_felt_any(&pair.settlement_data.ekubo_pool)?);
        let (low, high) = parse_u256_low_high(&pair.settlement_data.sqrt_price_limit)?;
        calldata.push(low);
        calldata.push(high);

        let call = Call {
            to: self.dark_pool_address,
            selector: get_selector_from_name("settle_match")?,
            calldata,
        };

        // Execute transaction (serialized to avoid nonce races).
        let _tx_guard = self.tx_mutex.lock().await;

        // Retry on nonce desync (can happen if a previous tx was accepted but our cache is stale,
        // or if we optimistically cached a nonce and the provider rejected the tx).
        let mut last_err: Option<anyhow::Error> = None;
        for attempt in 0..3 {
            let nonce = self.nonce_for_send().await?;
            match self
                .account
                .execute(vec![call.clone()])
                .nonce(nonce)
                .send()
                .await
            {
                Ok(result) => {
                    info!(
                        "Match settled successfully. Transaction hash: {:?}",
                        result.transaction_hash
                    );
                    self.mark_nonce_used(nonce).await;
                    return Ok(format!("{:?}", result.transaction_hash));
                }
                Err(e) => {
                    let msg = e.to_string();
                    // Any error means our cached nonce might now be wrong (or the tx might have been
                    // accepted but we didn't observe it). Reset unless we can seed it from the error.
                    //
                    // Patterns we've seen:
                    // - "NonceTooOld ..."
                    // - "InvalidTransactionNonce: ... account_nonce: Nonce(0x..)"
                    // - "Invalid transaction nonce ... Account nonce: 0x..; got: 0x.."
                    if msg.contains("NonceTooOld")
                        || msg.contains("InvalidTransactionNonce")
                        || msg.contains("Invalid transaction nonce")
                    {
                        if let Some(next) = parse_account_nonce_from_err(&msg) {
                            // Seed cache to the reported account nonce (mempool-aware) and retry.
                            self.seed_nonce_cache(next).await;
                        } else {
                            self.reset_nonce_cache().await;
                        }
                        last_err = Some(anyhow::anyhow!(msg.clone()));
                        if attempt + 1 < 3 {
                            continue;
                        }
                    }
                    self.reset_nonce_cache().await;
                    last_err = Some(anyhow::anyhow!(msg.clone()));
                    break;
                }
            }
        }

        Err(last_err.unwrap_or_else(|| anyhow::anyhow!("Failed to send settlement tx")))
    }

    /// Check if an intent has been settled on-chain
    pub async fn is_intent_settled(&self, nullifier: &str) -> Result<bool> {
        let call = FunctionCall {
            contract_address: self.dark_pool_address,
            entry_point_selector: get_selector_from_name("get_intent_status")?,
            calldata: vec![felt_from_hex(nullifier)?],
        };

        let result = self.provider.call(call, BlockId::Tag(BlockTag::Latest)).await?;

        // Status 2 = Settled
        Ok(!result.is_empty() && result[0] == Felt::from(2u8))
    }

    pub fn dark_pool_address(&self) -> Felt {
        self.dark_pool_address
    }

    pub async fn erc20_balance_of(&self, token: &str, owner: &str) -> Result<BigUint> {
        let call = FunctionCall {
            contract_address: felt_from_hex(token)?,
            entry_point_selector: get_selector_from_name("balanceOf")?,
            calldata: vec![felt_from_hex(owner)?],
        };
        let result = self.provider.call(call, BlockId::Tag(BlockTag::Latest)).await?;
        parse_u256_result(&result)
    }

    pub async fn erc20_allowance(&self, token: &str, owner: &str, spender: Felt) -> Result<BigUint> {
        let call = FunctionCall {
            contract_address: felt_from_hex(token)?,
            entry_point_selector: get_selector_from_name("allowance")?,
            calldata: vec![felt_from_hex(owner)?, spender],
        };
        let result = self.provider.call(call, BlockId::Tag(BlockTag::Latest)).await?;
        parse_u256_result(&result)
    }
}

fn parse_account_nonce_from_err(msg: &str) -> Option<Felt> {
    // Example (from logs):
    // InvalidTransactionNonce: "MempoolError(NonceTooOld { address: ..., tx_nonce: Nonce(0x10), account_nonce: Nonce(0x11) })"
    let needle = "account_nonce: Nonce(";
    if let Some(idx) = msg.find(needle) {
        let rest = &msg[idx + needle.len()..];
        let end = rest.find(')')?;
        let raw = rest[..end].trim();
        if raw.is_empty() {
            return None;
        }
        return Felt::from_hex(raw).ok();
    }

    // Alternative provider wording:
    // "Invalid transaction nonce ... Account nonce: 0x...; got: 0x..."
    parse_account_nonce_from_invalid_nonce(msg)
}

fn parse_account_nonce_from_invalid_nonce(msg: &str) -> Option<Felt> {
    // Example:
    // "Invalid transaction nonce ... Account nonce: 0x...; got: 0x..."
    let needle = "Account nonce:";
    let idx = msg.find(needle)?;
    let rest = msg[idx + needle.len()..].trim_start();
    let end = rest.find(';').unwrap_or(rest.len());
    let raw = rest[..end].trim();
    if raw.is_empty() {
        return None;
    }
    Felt::from_hex(raw).ok()
}

fn felt_from_hex(value: &str) -> Result<Felt> {
    // starknet-rs moved from FieldElement -> Felt. Keep parsing centralized so future changes are localized.
    Ok(Felt::from_hex(value)?)
}

fn parse_felt_any(value: &str) -> Result<Felt> {
    let v = value.trim();
    if v.is_empty() {
        return Ok(Felt::from(0u8));
    }

    // Many upstream values (e.g. nullifiers / hashes) can be 256-bit integers.
    // Cairo `felt252` must be < Starknet field prime. To keep the system robust,
    // we reduce any parsed integer modulo the Starknet field prime.
    let n = if v.starts_with("0x") || v.starts_with("0X") {
        BigUint::from_str_radix(v.trim_start_matches("0x").trim_start_matches("0X"), 16)?
    } else {
        BigUint::from_str_radix(v, 10)?
    };
    let p = starknet_field_prime();
    let n = n % &p;
    Ok(Felt::from_dec_str(&n.to_str_radix(10))?)
}

fn starknet_field_prime() -> BigUint {
    // Starknet field prime:
    // p = 2^251 + 17 * 2^192 + 1
    (BigUint::from(1u8) << 251) + (BigUint::from(17u8) << 192) + BigUint::from(1u8)
}

fn parse_u256_low_high(value: &str) -> Result<(Felt, Felt)> {
    // Minimal helper for cairo u256 encoding (low, high).
    // Accepts `0x...` hex or decimal string.
    let raw = value.trim();
    if raw.is_empty() || raw == "0" {
        return Ok((Felt::from(0u8), Felt::from(0u8)));
    }

    let n = if raw.starts_with("0x") || raw.starts_with("0X") {
        BigUint::from_str_radix(raw.trim_start_matches("0x").trim_start_matches("0X"), 16)?
    } else {
        BigUint::from_str_radix(raw, 10)?
    };

    let mask: BigUint = (BigUint::from(1u8) << 128) - 1u8;
    let low: BigUint = (&n & &mask).to_owned();
    let high: BigUint = n >> 128;

    let low_f = Felt::from_dec_str(&low.to_str_radix(10))?;
    let high_f = Felt::from_dec_str(&high.to_str_radix(10))?;
    Ok((low_f, high_f))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_felt_any_mods_large_hex_into_field() {
        // 2^256 - 1 (definitely larger than Starknet field prime)
        let f = parse_felt_any("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff")
            .expect("should parse and mod");
        // The result must be a valid felt, i.e. it parses and is within field.
        // `Felt` doesn't expose a direct range predicate; successful construction is enough.
        let _ = f;
    }

    #[test]
    fn parse_amount_18_to_felt_converts_decimals() {
        let f = parse_amount_18_to_felt("0.01").expect("parse");
        // 0.01 * 1e18 = 1e16
        assert_eq!(
            f,
            Felt::from_dec_str("10000000000000000").expect("felt")
        );
    }

    #[test]
    fn parse_amount_18_to_felt_converts_integer_tokens() {
        let f = parse_amount_18_to_felt("10").expect("parse");
        // 10 * 1e18
        assert_eq!(
            f,
            Felt::from_dec_str("10000000000000000000").expect("felt")
        );
    }

    #[test]
    fn parse_amount_to_felt_converts_usdc_decimals() {
        let f = parse_amount_to_felt("0.01", 6).expect("parse");
        // 0.01 * 1e6 = 10000
        assert_eq!(f, Felt::from_dec_str("10000").expect("felt"));
    }

    #[test]
    fn parse_amount_to_felt_converts_usdc_integer_tokens() {
        let f = parse_amount_to_felt("10", 6).expect("parse");
        // 10 * 1e6
        assert_eq!(f, Felt::from_dec_str("10000000").expect("felt"));
    }
}

fn parse_amount_18_to_felt(value: &str) -> Result<Felt> {
    parse_amount_to_felt(value, 18)
}

fn normalize_hex_address(value: &str) -> String {
    let v = value.trim().to_lowercase();
    if !v.starts_with("0x") {
        return v;
    }
    let hex = v.trim_start_matches("0x").trim_start_matches('0');
    let hex = if hex.is_empty() { "0" } else { hex };
    format!("0x{:0>64}", hex)
}

fn token_decimals(token_address: &str) -> u32 {
    // Starknet Sepolia common token addresses (same as the frontend's token list).
    // Default to 18 for unknown tokens.
    let a = normalize_hex_address(token_address);
    match a.as_str() {
        // ETH
        "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7" => 18,
        // STRK
        "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d" => 18,
        // USDC
        "0x053c91253bc9682c04929ca02ed00b3e423f6710d2ee7e0d5ebb06f3ecf368a8" => 6,
        // USDT
        "0x068f5c6a61780768455de69077e07e89787839bf8166decfbf92b645209c0fb8" => 6,
        _ => 18,
    }
}

fn parse_u256_result(result: &[Felt]) -> Result<BigUint> {
    if result.len() < 2 {
        return Err(anyhow::anyhow!("u256 response missing fields"));
    }
    // Starknet JSON-RPC and starknet-rs return u256 as [low, high]
    let low = BigUint::from_str_radix(&format!("{:x}", result[0]), 16)?;
    let high = BigUint::from_str_radix(&format!("{:x}", result[1]), 16)?;
    Ok(low + (high << 128u32))
}

fn parse_amount_to_felt(value: &str, decimals: u32) -> Result<Felt> {
    // The frontend submits human-readable token amounts like "0.01" or "10".
    // For on-chain settlement/circuit public inputs we need base units.
    //
    // Accept:
    // - integer decimal strings (interpreted as whole tokens, converted to base units)
    // - decimal strings with up to `decimals` fractional digits (interpreted as tokens, converted to base units)
    // - hex strings `0x...` treated as integer base units
    let v = value.trim();
    if v.is_empty() {
        return Ok(Felt::from(0u8));
    }
    if v.starts_with("0x") || v.starts_with("0X") {
        // Already an integer amount.
        return parse_felt_any(v);
    }
    if let Some((int_part, frac_part)) = v.split_once('.') {
        if int_part.is_empty() || int_part.chars().any(|c| !c.is_ascii_digit()) {
            return Err(anyhow::anyhow!("invalid decimal amount: {}", v));
        }
        if frac_part.chars().any(|c| !c.is_ascii_digit()) {
            return Err(anyhow::anyhow!("invalid decimal amount: {}", v));
        }
        if frac_part.len() > decimals as usize {
            return Err(anyhow::anyhow!("too many decimals (max {}): {}", decimals, v));
        }

        let ten_pow: BigUint = BigUint::from(10u8).pow(decimals);
        let int_n = BigUint::from_str_radix(int_part, 10)?;
        let mut frac = frac_part.to_string();
        while frac.len() < decimals as usize {
            frac.push('0');
        }
        let frac_n = if frac.is_empty() {
            BigUint::from(0u8)
        } else {
            BigUint::from_str_radix(&frac, 10)?
        };
        let n = (int_n * ten_pow) + frac_n;
        return Ok(Felt::from_dec_str(&n.to_str_radix(10))?);
    }

    // No dot: integer tokens (whole tokens) -> base units
    if v.chars().all(|c| c.is_ascii_digit()) {
        let ten_pow: BigUint = BigUint::from(10u8).pow(decimals);
        let int_n = BigUint::from_str_radix(v, 10)?;
        let n = int_n * ten_pow;
        return Ok(Felt::from_dec_str(&n.to_str_radix(10))?);
    }

    // Fall back to generic felt parsing for any other form.
    parse_felt_any(v)
}

pub fn token_decimals_for(token_address: &str) -> u32 {
    token_decimals(token_address)
}

pub fn parse_amount_to_base_units(value: &str, decimals: u32) -> Result<BigUint> {
    let v = value.trim();
    if v.is_empty() {
        return Ok(BigUint::from(0u8));
    }
    if v.starts_with("0x") || v.starts_with("0X") {
        return BigUint::from_str_radix(v.trim_start_matches("0x").trim_start_matches("0X"), 16)
            .map_err(|e| anyhow::anyhow!(e));
    }
    if let Some((int_part, frac_part)) = v.split_once('.') {
        if int_part.is_empty() || int_part.chars().any(|c| !c.is_ascii_digit()) {
            return Err(anyhow::anyhow!("invalid decimal amount: {}", v));
        }
        if frac_part.chars().any(|c| !c.is_ascii_digit()) {
            return Err(anyhow::anyhow!("invalid decimal amount: {}", v));
        }
        if frac_part.len() > decimals as usize {
            return Err(anyhow::anyhow!("too many decimals (max {}): {}", decimals, v));
        }

        let ten_pow: BigUint = BigUint::from(10u8).pow(decimals);
        let int_n = BigUint::from_str_radix(int_part, 10)?;
        let mut frac = frac_part.to_string();
        while frac.len() < decimals as usize {
            frac.push('0');
        }
        let frac_n = if frac.is_empty() {
            BigUint::from(0u8)
        } else {
            BigUint::from_str_radix(&frac, 10)?
        };
        return Ok((int_n * ten_pow) + frac_n);
    }

    if v.chars().all(|c| c.is_ascii_digit()) {
        let ten_pow: BigUint = BigUint::from(10u8).pow(decimals);
        let int_n = BigUint::from_str_radix(v, 10)?;
        return Ok(int_n * ten_pow);
    }

    Err(anyhow::anyhow!("invalid amount: {}", v))
}

fn public_inputs_to_felts(inputs: &crate::models::PublicInputs) -> Result<Vec<Felt>> {
    // Must match the circuit's public inputs order.
    // frontend/src/utils/prover.ts currently uses:
    // [user, tokenIn, tokenOut, amountIn, minAmountOut, deadline]
    let in_decimals = token_decimals(&inputs.token_in);
    let out_decimals = token_decimals(&inputs.token_out);
    Ok(vec![
        parse_felt_any(&inputs.user)?,
        parse_felt_any(&inputs.token_in)?,
        parse_felt_any(&inputs.token_out)?,
        parse_amount_to_felt(&inputs.amount_in, in_decimals)?,
        parse_amount_to_felt(&inputs.min_amount_out, out_decimals)?,
        Felt::from(inputs.deadline),
    ])
}

fn append_intent_proof(calldata: &mut Vec<Felt>, intent: &crate::models::Intent) -> Result<()> {
    calldata.push(parse_felt_any(&intent.intent_hash)?);
    calldata.push(parse_felt_any(&intent.nullifier)?);

    calldata.push(Felt::from(intent.proof_data.len() as u64));
    for el in &intent.proof_data {
        calldata.push(parse_felt_any(el)?);
    }

    // The on-chain DarkPool contract uses `public_inputs` for business logic
    // (_verify_intent_compatibility, _execute_settlement) and expects the layout:
    //   [user, token_in, token_out, amount_in, min_amount_out, deadline]
    //
    // `proof_public_inputs` now contains SNARK-native public signals
    // (intentHash, nullifier, currentTime) which are already embedded in the Garaga
    // calldata (`proof_data`). The IntentVerifier ignores the `public_inputs` span
    // for Groth16 verification, so we must always reconstruct the business-field
    // layout here regardless of whether proof_public_inputs is populated.
    let pub_inputs = public_inputs_to_felts(&intent.public_inputs)?;
    calldata.push(Felt::from(pub_inputs.len() as u64));
    calldata.extend(pub_inputs);
    Ok(())
}
