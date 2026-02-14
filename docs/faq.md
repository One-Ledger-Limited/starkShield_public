# Frequently Asked Questions

## General Questions

### What is StarkShield?

StarkShield is a **client-side zero-knowledge dark pool** on Starknet that enables MEV-free trading. Users generate ZK proofs locally that encode trade intents without revealing order details to the public mempool.

### Why do we need StarkShield?

Public blockchains expose pending transactions in the mempool, enabling:
- **Sandwich attacks**: Bots exploit price movements
- **Front-running**: Orders executed before yours
- **Portfolio leakage**: Trade sizes revealed
- **Slippage**: Large orders move prices

StarkShield solves these by keeping orders private until execution.

### How is this different from other dark pools?

| Feature | StarkShield | Other Dark Pools |
|---------|-------------|------------------|
| Client-side proofs | ✅ | ❌ |
| No trusted relayers | ✅ | ❌ |
| Starknet native | ✅ | ❌ |
| Open source | ✅ | Mixed |

## Technical Questions

### How do ZK proofs work?

1. **User creates trade** in browser
2. **Circuit generates proof** that user has sufficient balance, approval, etc.
3. **Proof is submitted** to solver (encrypted details stay private)
4. **Solver matches** compatible intents
5. **Contract verifies** both proofs on-chain
6. **Settlement occurs** atomically

### What information is kept private?

- Trade amounts
- Token pairs (until match)
- Order direction
- User identity (linkable via nullifier)

**Public:**
- Proof of validity
- Intent hash
- Nullifier (prevents double-spending)

### Is it fully decentralized?

**Current (MVP):** Solver is centralized but cannot see intent contents

**Phase 2:** TEE-secured solver network

**Phase 3:** Fully permissionless matching

### What are the costs?

**Gas Costs:**
- Intent submission: ~50,000 gas
- Settlement: ~100,000 gas

**Protocol Fee:** 0.3% (30 bps)

**Proving Time:** ~8 seconds (client-side)

### Which wallets are supported?

- Argent X
- Braavos
- MetaMask (via Starknet Snap)

### What tokens can I trade?

Any ERC-20 tokens on Starknet, including:
- ETH
- STRK
- USDC
- USDT
- DAI
- And more!

## Security Questions

### Is my money safe?

Yes! The smart contracts:
- Are non-custodial (we never hold your funds)
- Use audited patterns
- Have been tested extensively

### What if the solver goes down?

You can:
- Cancel pending intents anytime
- Withdraw funds (they never leave your wallet until settlement)
- Use alternative solvers (Phase 2)

### Can the solver steal my funds?

No! The solver:
- Cannot decrypt intent contents
- Can only match valid proofs
- Cannot settle without your signature
- Settlement requires both parties

### What prevents double-spending?

Each intent has a **nullifier** - a unique identifier derived from your address and a random salt. Once an intent is settled, the nullifier is marked as used and cannot be reused.

## Usage Questions

### How long does a trade take?

- **Proof generation:** ~8 seconds
- **Matching:** 30 seconds - 2 minutes
- **Settlement:** 2 minutes (Starknet block time)

Total: ~3-5 minutes

### What if my intent isn't matched?

Intents expire after the deadline (default: 1 hour). You can:
- Cancel anytime before expiry
- Resubmit with better terms
- Wait for a match

### Can I cancel my intent?

Yes! As long as it hasn't been settled, you can cancel through the UI or directly on-chain.

### What happens if prices change?

Your trade only executes if:
- Minimum output amount is met
- Counterparty's requirements are satisfied

If market moves against you, the trade won't settle and you can resubmit.

## Development Questions

### How can I run a solver?

See the [Solver Documentation](./solver.md). Requirements:
- Rust 1.70+
- Redis
- Staked tokens (Phase 2)

### How do I integrate with StarkShield?

For DEXs: Contact us for integration guide

For wallets: Use our SDK (coming soon)

For developers: Check our [API docs](./api.md)

### Where can I see the code?

All code is open source on GitHub:
- github.com/your-org/starkshield

## Troubleshooting

### "Proof generation failed"

- Check browser console for errors
- Ensure you have sufficient token balance
- Verify you've approved the DarkPool contract
- Try refreshing the page

### "Intent not found"

- Wait a few seconds for blockchain confirmation
- Check your wallet for transaction status
- Verify the nullifier is correct

### "Settlement failed"

- Check both intents are still pending
- Verify amounts are compatible
- Ensure deadline hasn't passed
- Contact support if issue persists

## Getting Help

- **Email:** info@shieldtrade.io

## Still have questions?

Email us at info@shieldtrade.io.
