use starknet::{
    accounts::{Account, ExecutionEncoding, SingleOwnerAccount},
    core::types::{BlockId, BlockTag, Call, Felt, FunctionCall},
    core::utils::get_selector_from_name,
    providers::{jsonrpc::HttpTransport, JsonRpcClient, Provider},
    signers::{LocalWallet, SigningKey},
};
use anyhow::Result;
use std::sync::Arc;
use tracing::info;

use crate::models::MatchedPair;
use num_bigint::BigUint;
use num_traits::Num;

pub struct StarknetClient {
    provider: Arc<JsonRpcClient<HttpTransport>>,
    account: Arc<SingleOwnerAccount<Arc<JsonRpcClient<HttpTransport>>, LocalWallet>>,
    dark_pool_address: Felt,
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
        })
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

        // Execute transaction
        let result = self.account.execute(vec![call]).send().await?;

        info!(
            "Match settled successfully. Transaction hash: {:?}",
            result.transaction_hash
        );

        Ok(format!("{:?}", result.transaction_hash))
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
}

fn parse_amount_18_to_felt(value: &str) -> Result<Felt> {
    // The frontend currently submits human-readable decimals like "0.01".
    // For on-chain settlement we need base units. STRK and ETH both use 18 decimals on Starknet.
    //
    // Accept:
    // - integer decimal strings (already base units or whole tokens)
    // - decimal strings with up to 18 fractional digits (interpreted as tokens, converted to base units)
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
        if frac_part.len() > 18 {
            return Err(anyhow::anyhow!("too many decimals (max 18): {}", v));
        }

        let ten_pow_18: BigUint = BigUint::from(10u8).pow(18u32);
        let int_n = BigUint::from_str_radix(int_part, 10)?;
        let mut frac = frac_part.to_string();
        while frac.len() < 18 {
            frac.push('0');
        }
        let frac_n = if frac.is_empty() {
            BigUint::from(0u8)
        } else {
            BigUint::from_str_radix(&frac, 10)?
        };
        let n = (int_n * ten_pow_18) + frac_n;
        return Ok(Felt::from_dec_str(&n.to_str_radix(10))?);
    }

    // No dot: treat as integer.
    parse_felt_any(v)
}

fn public_inputs_to_felts(inputs: &crate::models::PublicInputs) -> Result<Vec<Felt>> {
    // Must match the circuit's public inputs order.
    // frontend/src/utils/prover.ts currently uses:
    // [user, tokenIn, tokenOut, amountIn, minAmountOut, deadline]
    Ok(vec![
        parse_felt_any(&inputs.user)?,
        parse_felt_any(&inputs.token_in)?,
        parse_felt_any(&inputs.token_out)?,
        parse_amount_18_to_felt(&inputs.amount_in)?,
        parse_amount_18_to_felt(&inputs.min_amount_out)?,
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

    let pub_inputs = public_inputs_to_felts(&intent.public_inputs)?;
    calldata.push(Felt::from(pub_inputs.len() as u64));
    calldata.extend(pub_inputs);
    Ok(())
}
