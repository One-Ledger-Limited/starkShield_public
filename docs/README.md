# StarkShield

## Client-Side ZK Dark Pool for MEV-Free Trading

**Tagline:** Client-Side ZK Dark Pool for MEV-Free Trading on Starknet

### Quick Links

- [Architecture Overview](./architecture.md)
- [Getting Started Guide](./getting-started.md)
- [API Documentation](./api.md)
- [Security](../SECURITY.md)

### Project Structure

```
StarkShield/
├── contracts/          # Cairo smart contracts
│   ├── DarkPool.cairo
│   ├── IntentVerifier.cairo
│   └── Scarb.toml
├── frontend/           # React frontend application
│   ├── src/
│   ├── package.json
│   └── vite.config.ts
├── solver/             # Rust solver service
│   ├── src/
│   ├── Cargo.toml
│   └── .env.example
├── circuits/           # ZK circuits (Circom)
│   ├── intent_circuit.circom
│   ├── settlement_circuit.circom
│   └── package.json
├── tests/              # Integration tests
├── docs/               # Documentation
├── scripts/            # Deployment and utility scripts
├── Makefile            # Build and development commands
└── .env.example        # Environment configuration template
```

### What is StarkShield?

StarkShield is a **client-side zero-knowledge dark pool** built on Starknet that enables:

- **MEV-Free Trading**: Your orders never hit the public mempool
- **Privacy Protection**: Trade sizes and directions remain hidden
- **Client-Side Security**: ZK proofs generated locally in your browser
- **Atomic Settlement**: Trustless matching and settlement via smart contracts

### Key Features

#### 🔐 Client-Side Conditional Proofs
Users generate ZK proofs locally that encode:
```
"I authorize this trade if and only if I receive at least Y output for X input"
```

#### ⚛️ Atomic Dual-Proof Settlement
Trades clear only if both proofs match exactly, ensuring:
- No front-running
- No sandwich attacks
- Fair execution for both parties

#### 🛡️ MEV Elimination by Design
No public mempool exposure means:
- Block builders can't extract value
- Trade details remain private until execution
- Institutions can trade with confidence

### Technology Stack

| Component | Technology |
|-----------|-----------|
| Smart Contracts | Cairo v2 |
| Frontend | React + TypeScript + starknet.js |
| Solver | Rust + Axum + Redis |
| ZK Proofs | Circom + snarkjs + Garaga |
| DEX Integration | Ekubo AMM |

### Quick Start

```bash
# 1. Clone the repository
git clone https://github.com/Shield-Trade/starkShield_public.git
cd starkshield

# 2. Install dependencies
make install

# 3. Set up environment
cp .env.example .env
# Edit .env with your configuration

# 4. Build all components
make build

# 5. Start local devnet
make start-devnet

# 6. Deploy contracts
make deploy-contracts

# 7. Start solver
make start-solver

# 8. Start frontend (in new terminal)
make dev
```

Visit `http://localhost:5173` to access the application.

### Architecture

See [Architecture Overview](./architecture.md) for detailed system design.

High-level flow:
1. **User signs** trade intent in browser
2. **Client generates** ZK proof locally
3. **Proof sent** privately to solver
4. **Solver matches** counter-intent
5. **Cairo contract** verifies atomic compatibility
6. **Ekubo executes** swap
7. **Funds settle** to users

### Testing

```bash
# Run all tests
make test

# Run specific test suites
make test-contracts    # Cairo contract tests
make test-solver       # Rust solver tests
make test-circuits     # ZK circuit tests
```

### Contributing

We welcome contributions! Please see [CONTRIBUTING.md](../CONTRIBUTING.md) for guidelines.

### Security

- Smart contracts are audited by [Audit Firm]
- ZK circuits use well-tested Circom libraries
- All code is open source and verifiable

Report security issues to: info@shieldtrade.io

### License

This project is licensed under the MIT License.

### Acknowledgments

- [Garaga](https://github.com/keep-starknet-strange/garaga) - ZK verification on Starknet
- [Ekubo](https://ekubo.org) - Concentrated liquidity AMM
- [Starknet](https://starknet.io) - Layer 2 scaling solution

### Contact

- Email: info@shieldtrade.io
