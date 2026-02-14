# StarkShield

**Client-Side ZK Dark Pool for MEV-Free Trading on Starknet**

[![Starknet](https://img.shields.io/badge/Starknet-0.13+-blue)](https://starknet.io)
[![Cairo](https://img.shields.io/badge/Cairo-2.0+-green)](https://cairo-lang.org)
[![License](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## Overview

StarkShield is a client-side zero-knowledge dark pool that enables MEV-free trading on Starknet. Users generate ZK proofs locally in their browser that encode trade intents without exposing order details to the public mempool.

## Key Features

- **Client-Side Proof Generation**: Trade intents are encoded as ZK proofs entirely in the browser
- **MEV Protection**: No public mempool exposure means no sandwich attacks
- **Atomic Settlement**: Dual-proof verification ensures trustless matching
- **Starknet Native**: Built on Cairo v2 with full account abstraction support

## Problem Statement

Public blockchains expose pending transactions in the mempool, enabling:
- Sandwich attacks and toxic MEV
- Slippage for whales executing large orders
- Portfolio size leakage creating physical security risks
- Institutions avoiding on-chain trading due to execution uncertainty

## Solution

StarkShield introduces a client-side zero-knowledge intent system:

```
"I authorize this trade if and only if I receive at least Y output for X input"
```

These encrypted intents are:
1. Matched off-chain by a solver
2. Submitted to Starknet as paired proofs
3. Atomically verified by a Cairo contract
4. Settled without ever revealing the order to the public mempool

## Architecture

```
┌─────────────┐      ┌──────────────┐      ┌─────────────┐
│   Browser   │──────▶│    ZK Prover │──────▶│   Solver    │
│  (Client)   │      │   (Garaga)   │      │   (Rust)    │
└─────────────┘      └──────────────┘      └──────┬──────┘
       │                                           │
       │           ┌───────────────────────────────┘
       │           │
       │    ┌──────▼──────┐
       └───▶│   Cairo     │
            │   Verifier  │
            └──────┬──────┘
                   │
            ┌──────▼──────┐
            │   Ekubo     │
            │     DEX     │
            └─────────────┘
```

## Repository Structure

```
StarkShield/
├── contracts/          # Cairo smart contracts
├── frontend/           # React frontend application
├── solver/             # Rust solver service
├── circuits/           # ZK circuits and prover
├── docs/               # Documentation
└── tests/              # Test suites
```

## Quick Start

### Prerequisites

- Node.js 18+
- Rust 1.70+
- Python 3.9+ (for Garaga)
- Starknet CLI tools

### Installation

```bash
# Clone the repository
git clone https://github.com/your-org/starkshield.git
cd starkshield

# Install dependencies
npm install
cargo build --release

# Compile Cairo contracts
make build-contracts
```

### Running Locally

```bash
# Start the local Starknet devnet
make start-devnet

# Deploy contracts
make deploy-contracts

# Start the solver
make start-solver

# Start the frontend
cd frontend && npm run dev
```

## Documentation

- [Architecture Overview](./docs/architecture.md)
- [Cairo Contracts](./docs/contracts.md)
- [API Reference](./docs/api.md)
- [Getting Started](./docs/getting-started.md)
- [Hackathon Delivery Playbook](./doc/Hackathon_Delivery_Playbook.md)

## Testing

```bash
# Run contract tests
make test-contracts

# Run solver tests
cargo test

# Run frontend tests
npm test

# Run integration tests
make test-integration
```

## Roadmap

### Phase 1 (Current)
- [x] Client-side proof generation
- [x] Cairo verifier contracts
- [x] Basic solver implementation
- [x] Ekubo integration

### Phase 2 (Next)
- [ ] Trace-optimized Cairo circuits
- [ ] WASM prover for sub-3s browser proving
- [ ] TEE-secured solver nodes
- [ ] Encrypted intent pools

### Phase 3
- [ ] Bitcoin light-client settlement
- [ ] Trustless Stark-BTC bridges
- [ ] BTCFi integrations

## Contributing

We welcome contributions! Please see [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines.

## License

This project is licensed under the MIT License - see the [LICENSE](./LICENSE) file for details.

## Acknowledgments

- [Garaga](https://github.com/keep-starknet-strange/garaga) - ZK verification on Starknet
- [Ekubo](https://ekubo.org) - Concentrated liquidity AMM
- [Starknet](https://starknet.io) - Layer 2 scaling solution

## Contact

- Twitter: [@StarkShield](https://twitter.com/starkshield)
- Discord: [Join our server](https://discord.gg/starkshield)
- Email: team@starkshield.io
