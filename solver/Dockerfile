FROM rust:1.88-slim as builder

WORKDIR /app

# Install dependencies
RUN apt-get update && apt-get install -y \
    pkg-config \
    libssl-dev \
    && rm -rf /var/lib/apt/lists/*

# Copy Cargo manifest and generate a lockfile inside the build container.
# The repo may omit Cargo.lock; generating here avoids build failures.
COPY Cargo.toml ./
RUN cargo generate-lockfile

# Copy source code
COPY src ./src

# Build release binary
RUN cargo build --release

# Runtime stage
FROM debian:bookworm-slim

WORKDIR /app

# Install runtime dependencies
RUN apt-get update && apt-get install -y \
    ca-certificates \
    libssl3 \
    && rm -rf /var/lib/apt/lists/*

# Copy binary from builder
COPY --from=builder /app/target/release/solver /app/solver

# Expose port
EXPOSE 8080

# Run the solver
CMD ["./solver"]
