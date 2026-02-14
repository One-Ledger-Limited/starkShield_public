use sha3::{Digest, Keccak256};
use hex;

/// Hash data using Keccak256
pub fn keccak256(data: &[u8]) -> [u8; 32] {
    let mut hasher = Keccak256::new();
    hasher.update(data);
    hasher.finalize().into()
}

/// Convert bytes to hex string
pub fn bytes_to_hex(bytes: &[u8]) -> String {
    hex::encode(bytes)
}

/// Parse hex string to bytes
pub fn hex_to_bytes(hex: &str) -> Result<Vec<u8>, hex::FromHexError> {
    let hex = hex.trim_start_matches("0x");
    hex::decode(hex)
}

/// Truncate address for display
pub fn truncate_address(address: &str) -> String {
    if address.len() <= 10 {
        return address.to_string();
    }
    format!("{}...{}", &address[..6], &address[address.len()-4..])
}

/// Format amount with decimals
pub fn format_amount(amount: &str, decimals: u8) -> String {
    if let Ok(val) = amount.parse::<f64>() {
        let divisor = 10f64.powi(decimals as i32);
        format!("{:.6}", val / divisor)
    } else {
        amount.to_string()
    }
}

/// Generate a unique ID
pub fn generate_id() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    let bytes: [u8; 16] = rng.gen();
    format!("0x{}", hex::encode(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_keccak256() {
        let data = b"hello world";
        let hash = keccak256(data);
        assert_eq!(hash.len(), 32);
    }

    #[test]
    fn test_hex_conversion() {
        let bytes = vec![0x12, 0x34, 0x56, 0x78];
        let hex = bytes_to_hex(&bytes);
        assert_eq!(hex, "12345678");
        
        let decoded = hex_to_bytes(&hex).unwrap();
        assert_eq!(decoded, bytes);
    }

    #[test]
    fn test_truncate_address() {
        let addr = "0x1234567890abcdef1234567890abcdef12345678";
        let truncated = truncate_address(addr);
        assert_eq!(truncated, "0x1234...5678");
    }
}