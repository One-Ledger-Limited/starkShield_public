# StarkShield Makefile
# Build, test, and deploy commands

.PHONY: help install build test deploy clean

# Default target
help:
	@echo "StarkShield - Available commands:"
	@echo "  make install          - Install all dependencies"
	@echo "  make build            - Build all components"
	@echo "  make build-contracts  - Build Cairo contracts"
	@echo "  make build-frontend   - Build frontend application"
	@echo "  make build-solver     - Build Rust solver"
	@echo "  make build-circuits   - Compile ZK circuits"
	@echo "  make test             - Run all tests"
	@echo "  make test-contracts   - Run Cairo contract tests"
	@echo "  make test-solver      - Run Rust solver tests"
	@echo "  make test-circuits    - Run circuit tests"
	@echo "  make start-devnet     - Start local Starknet devnet"
	@echo "  make deploy-contracts - Deploy contracts to devnet"
	@echo "  make start-solver     - Start the solver service"
	@echo "  make dev              - Start frontend dev server"
	@echo "  make clean            - Clean all build artifacts"

# Installation
install:
	@echo "Installing dependencies..."
	cd contracts && scarb fetch
	cd frontend && npm install
	cd solver && cargo fetch
	cd circuits && npm install

# Build commands
build: build-contracts build-frontend build-solver build-circuits

build-contracts:
	@echo "Building Cairo contracts..."
	cd contracts && scarb build

build-frontend:
	@echo "Building frontend..."
	cd frontend && npm run build

build-solver:
	@echo "Building Rust solver..."
	cd solver && cargo build --release

build-circuits:
	@echo "Compiling ZK circuits..."
	cd circuits && npm run compile:all

# Test commands
test: test-contracts test-solver test-circuits

test-contracts:
	@echo "Running Cairo contract tests..."
	cd contracts && snforge test

test-solver:
	@echo "Running Rust solver tests..."
	cd solver && cargo test

test-circuits:
	@echo "Running circuit tests..."
	cd circuits && npm run test:all

test-integration:
	@echo "Running integration tests..."
	cd tests && npm test

# Development commands
start-devnet:
	@echo "Starting Starknet devnet..."
	starknet-devnet --seed 0 --fork-network alpha-sepolia

deploy-contracts:
	@echo "Deploying contracts..."
	node scripts/deploy.js

start-solver:
	@echo "Starting solver service..."
	cd solver && cargo run --release

dev:
	@echo "Starting frontend dev server..."
	cd frontend && npm run dev

# Docker commands
docker-build:
	@echo "Building Docker images..."
	docker-compose build

docker-up:
	@echo "Starting Docker services..."
	docker-compose up -d

docker-down:
	@echo "Stopping Docker services..."
	docker-compose down

# Utilities
format:
	@echo "Formatting code..."
	cd contracts && scarb fmt
	cd solver && cargo fmt
	cd frontend && npm run lint -- --fix

lint:
	@echo "Running linters..."
	cd contracts && scarb fmt --check
	cd solver && cargo clippy -- -D warnings
	cd frontend && npm run lint

clean:
	@echo "Cleaning build artifacts..."
	cd contracts && scarb clean
	cd solver && cargo clean
	cd frontend && rm -rf dist node_modules
	cd circuits && rm -rf build node_modules

# Documentation
docs:
	@echo "Generating documentation..."
	cd contracts && scarb doc
	cd solver && cargo doc --no-deps

# Production
deploy-production:
	@echo "Deploying to production..."
	# Add production deployment commands here

# Security audit
audit:
	@echo "Running security audits..."
	cd frontend && npm audit
	cd solver && cargo audit