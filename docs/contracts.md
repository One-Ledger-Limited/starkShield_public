# StarkShield Smart Contracts

## Overview

StarkShield's smart contracts are written in **Cairo v2** and deployed on Starknet. They handle:

- Intent verification via ZK proofs
- Atomic settlement of matched trades
- Fee distribution
- Administrative functions

## Contract Architecture

```
┌─────────────────────────────────────────────────────┐
│                    DarkPool                         │
│              (Main Coordination)                    │
├─────────────────────────────────────────────────────┤
│ - Intent submission & tracking                      │
│ - Settlement coordination                           │
│ - Fee management                                    │
└──────────────┬──────────────────────────────────────┘
               │
    ┌──────────▼──────────┐
    │   IntentVerifier    │
    │   (ZK Verification) │
    └──────────┬──────────┘
               │
    ┌──────────▼──────────┐
    │ SettlementEngine    │
    │ (Ekubo Integration) │
    └─────────────────────┘
```

## DarkPool Contract

### Core Functions

#### `submit_intent(proof: IntentProof)`
Submits a new trade intent with ZK proof.

**Parameters:**
- `proof.intent_hash`: Poseidon hash of intent parameters
- `proof.nullifier`: Unique identifier to prevent double-spending
- `proof.proof_data`: Groth16 proof (8 field elements)
- `proof.public_inputs`: Public inputs (6 field elements)

**Events:**
- `IntentSubmitted`: Emitted on successful submission
- `ProofVerified`: Emitted after proof validation

#### `settle_match(intent_a, intent_b, settlement_data)`
Settles a matched pair of intents atomically.

**Access:** Solver only (in MVP)

**Parameters:**
- `intent_a`: First intent proof
- `intent_b`: Second intent proof
- `settlement_data`: Ekubo pool configuration

**Requirements:**
- Both intents must be pending
- Tokens must be complementary pairs
- Amounts must satisfy minimum outputs
- Both proofs must be valid

**Events:**
- `IntentSettled`: Emitted on successful settlement

#### `cancel_intent(nullifier)`
Cancels a pending intent.

**Access:** Intent owner only

#### `get_intent_status(nullifier)`
Returns current status of an intent.

**Returns:**
- `Pending`: Awaiting match
- `Matched`: Paired with counterparty
- `Settled`: Successfully executed
- `Cancelled`: User cancelled
- `Expired`: Past deadline

### Data Structures

```cairo
struct TradeIntent {
    user: ContractAddress,
    token_in: ContractAddress,
    token_out: ContractAddress,
    amount_in: u256,
    min_amount_out: u256,
    deadline: u64,
    salt: felt252,
}

struct IntentProof {
    intent_hash: felt252,
    nullifier: felt252,
    proof_data: Array<felt252>,  // Groth16 proof
    public_inputs: Array<felt252>,
}
```

## IntentVerifier Contract

### Purpose
Verifies Groth16 ZK proofs using Garaga library.

### Key Functions

#### `verify_intent_proof(intent_hash, nullifier, proof_data, public_inputs)`
Verifies that a proof attests to valid intent constraints.

**Verification Steps:**
1. Check nullifier not already used
2. Decode Groth16 proof from field elements
3. Verify pairing equation: e(A,B) = e(α,β) × e(accumulated_input,γ) × e(C,δ)
4. Return verification result

### Verification Key
Stored on-chain and updatable by admin. Contains:
- Alpha G1 point
- Beta G2 point  
- Gamma G2 point
- Delta G2 point
- IC points for public inputs

## Settlement Flow

```
1. Solver calls settle_match(intent_a, intent_b)
   ↓
2. Verify both intents are pending
   ↓
3. Verify both ZK proofs via IntentVerifier
   ↓
4. Verify token pairs are complementary
   ↓
5. Verify amounts satisfy minimum outputs
   ↓
6. Transfer tokens from users to contract
   ↓
7. Execute settlement (direct swap or via Ekubo)
   ↓
8. Transfer tokens to counterparties (minus fees)
   ↓
9. Mark intents as settled
   ↓
10. Emit IntentSettled event
```

## Security Considerations

### Access Control

**Owner Functions:**
- Update verifier contract
- Update fee recipient
- Update protocol fees (max 10%)
- Pause/unpause contract

**Solver Functions:**
- Settle matched intents
- Cannot decrypt intent contents

### Economic Security

**Nullifier Scheme:**
- Prevents double-spending
- Unique per intent
- Tracked on-chain

**Minimum Amounts:**
- Protects against extreme slippage
- Enforced on-chain
- Must be satisfied for settlement

**Deadline Enforcement:**
- Expired intents cannot be settled
- Solver responsible for checking
- Users can cancel expired intents

## Fee Structure

### Protocol Fee
- Default: 0.3% (30 bps)
- Maximum: 10% (configurable by owner)
- Sent to fee_recipient

### Fee Calculation
```cairo
fee = (amount * protocol_fee_bps) / 10000
```

## Integration with Ekubo

### Direct Integration
For MVP, StarkShield performs direct token transfers between matched parties.

### Future: Ekubo Router
Phase 2 will integrate with Ekubo's router for:
- Price discovery
- Slippage protection
- Liquidity optimization

## Deployment

### Testnet (Sepolia)
```bash
# Set environment
export STARKNET_NETWORK=sepolia
export STARKNET_WALLET=starkware.starknet.wallets.open_zeppelin.OpenZeppelinAccount

# Deploy
starknet deploy --contract DarkPool --inputs <constructor_args>
```

### Constructor Arguments
```
1. owner: ContractAddress
2. verifier_contract: ContractAddress
3. ekubo_router: ContractAddress
4. fee_recipient: ContractAddress
5. protocol_fee_bps: u16
```

## Testing

### Unit Tests
```bash
cd contracts
snforge test
```

### Integration Tests
```bash
cd tests
npm test
```

## Gas Optimization

### Current Gas Costs (approximate)
- Intent submission: ~50,000 gas
- Settlement: ~100,000 gas
- Cancellation: ~20,000 gas

### Optimization Strategies
- Batch verification (Phase 2)
- Storage packing
- Efficient data structures

## Upgrade Path

### Phase 2 Improvements
- Batch settlement (multiple pairs in one tx)
- Optimized verifier (Garaga v2)
- Additional DEX integrations

### Phase 3 Features
- Cross-chain settlement
- Bitcoin light client
- Advanced order types

## Audit Information

**Current Status:** Pre-audit

**Planned Audits:**
- Internal security review
- External audit (TBD)
- Formal verification (Phase 2)

**Known Limitations:**
- Solver centralization in MVP
- Proof verification is placeholder (needs Garaga integration)
- Limited to direct transfers (no AMM routing yet)

## References

- [Cairo Documentation](https://cairo-lang.org/docs/)
- [Starknet Documentation](https://docs.starknet.io/)
- [Garaga Repository](https://github.com/keep-starknet-strange/garaga)
- [Ekubo Documentation](https://docs.ekubo.org/)