# Getting Started with StarkShield

This guide will help you set up and run StarkShield locally for development.

## Prerequisites

### Required Software

1. **Node.js** (v18 or later)
   ```bash
   # Install via nvm
   curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
   nvm install 18
   nvm use 18
   ```

2. **Rust** (v1.70 or later)
   ```bash
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   ```

3. **Python** (v3.9 or later) - For Garaga
   ```bash
   # macOS
   brew install python@3.9
   
   # Ubuntu
   sudo apt-get install python3.9 python3.9-dev
   ```

4. **Scarb** - Cairo package manager
   ```bash
   curl --proto '=https' --tlsv1.2 -sSf https://docs.swmansion.com/scarb/install.sh | sh
   ```

5. **Starknet Foundry** - For testing Cairo contracts
   ```bash
   curl -L https://raw.githubusercontent.com/foundry-rs/starknet-foundry/master/scripts/install.sh | sh
   ```

6. **Redis** - For solver storage
   ```bash
   # macOS
   brew install redis
   brew services start redis
   
   # Ubuntu
   sudo apt-get install redis-server
   sudo service redis-server start
   ```

7. **Starknet Devnet** - Local testing environment
   ```bash
   pip install starknet-devnet
   ```

## Installation

### 1. Clone the Repository

```bash
git clone https://github.com/your-org/starkshield.git
cd starkshield
```

### 2. Install Dependencies

```bash
# This will install all dependencies for all components
make install
```

Or install individually:

```bash
# Cairo contracts
cd contracts && scarb fetch

# Frontend
cd frontend && npm install

# Solver
cd solver && cargo fetch

# Circuits
cd circuits && npm install
```

### 3. Configure Environment

Copy the example environment file:

```bash
cp .env.example .env
```

Edit `.env` with your configuration:

```bash
# Required: Set your solver private key
SOLVER_PRIVATE_KEY=your_private_key_here

# Optional: Configure RPC endpoints
STARKNET_RPC=https://starknet-sepolia.public.blastapi.io

# Optional: Contract addresses (will be auto-populated after deployment)
DARK_POOL_ADDRESS=0x...
```

## Development Workflow

### Start Local Devnet

```bash
make start-devnet
```

This starts a local Starknet devnet at `http://127.0.0.1:5050`.

### Deploy Contracts

```bash
make deploy-contracts
```

This will:
1. Compile Cairo contracts
2. Deploy to local devnet
3. Update `.env` with contract addresses

### Start the Solver

```bash
make start-solver
```

The solver will start on `http://localhost:8080` and connect to Redis.

### Start the Frontend

```bash
make dev
```

This starts the React development server at `http://localhost:5173`.

## Testing

### Run All Tests

```bash
make test
```

### Component-Specific Tests

```bash
# Cairo contract tests
make test-contracts

# Rust solver tests
make test-solver

# Circuit tests
make test-circuits

# Integration tests
make test-integration
```

### Manual Testing

1. **Connect Wallet**: Open the frontend and connect your wallet (Argent X or Braavos)

2. **Fund Account**: Use the devnet's built-in faucet or mint tokens

3. **Create Intent**:
   - Select input/output tokens
   - Enter amounts
   - Generate ZK proof
   - Submit intent

4. **Monitor Status**: Watch the intent status panel for matching

5. **Verify Settlement**: Check your wallet for token transfers

## Troubleshooting

### Common Issues

#### "Redis connection refused"
```bash
# Ensure Redis is running
redis-cli ping  # Should return "PONG"

# If not running:
brew services start redis  # macOS
sudo service redis-server start  # Ubuntu
```

#### "Cairo contract compilation failed"
```bash
# Update Scarb
scarb --version  # Check version
curl --proto '=https' --tlsv1.2 -sSf https://docs.swmansion.com/scarb/install.sh | sh
```

#### "snarkjs command not found"
```bash
# Install globally or use npx
cd circuits && npm install
```

#### "Solver failed to start"
```bash
# Check if port 8080 is in use
lsof -i :8080

# Or check logs
cd solver && RUST_LOG=debug cargo run
```

### Getting Help

- **Email**: info@shieldtrade.io
- **Documentation**: Check the `/docs` directory

## Next Steps

- Read the [Architecture Overview](./architecture.md) to understand the system
- Review [Smart Contract Documentation](./contracts.md) for Cairo details
- Explore the [API Reference](./api.md) for solver endpoints

## Advanced Configuration

### Custom RPC Endpoints

Edit `.env` to use your own Starknet RPC:

```bash
STARKNET_RPC=https://your-custom-rpc.com
```

### Solver Configuration

Tune matching parameters in `.env`:

```bash
MIN_MATCH_AMOUNT_USD=100.0      # Minimum trade size
MAX_SLIPPAGE_BPS=50             # Maximum slippage (0.5%)
MATCH_TIMEOUT_SECONDS=300       # Intent expiration
BATCH_SIZE=10                   # Matching batch size
```

### Frontend Customization

Edit `frontend/.env` for frontend-specific settings:

```bash
VITE_SOLVER_URL=http://localhost:8080
VITE_DEFAULT_SLIPPAGE=0.5
```

Happy coding! 🚀
