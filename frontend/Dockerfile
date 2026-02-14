# Build stage
FROM node:18-alpine as builder

WORKDIR /app

# Build-time env for Vite
ARG VITE_SOLVER_URL
ARG VITE_SOLVER_API_URL
ARG VITE_STARKNET_RPC
ARG VITE_DARK_POOL_ADDRESS
ENV VITE_SOLVER_URL=${VITE_SOLVER_URL}
ENV VITE_SOLVER_API_URL=${VITE_SOLVER_API_URL}
ENV VITE_STARKNET_RPC=${VITE_STARKNET_RPC}
ENV VITE_DARK_POOL_ADDRESS=${VITE_DARK_POOL_ADDRESS}

# Copy package files
COPY package*.json ./

# Ensure public registry; some servers have stale auth or custom registry settings.
# Add retry/timeouts to reduce flaky deploy failures from transient network issues.
RUN set -e; \
    npm config set registry https://registry.npmjs.org/; \
    npm config set fetch-retries 5; \
    npm config set fetch-retry-mintimeout 20000; \
    npm config set fetch-retry-maxtimeout 120000; \
    npm config set fetch-timeout 600000; \
    i=1; \
    while [ "$i" -le 5 ]; do \
      echo "npm install attempt $i/5"; \
      npm install --no-audit --no-fund --prefer-offline && break; \
      i=$((i+1)); \
      sleep 5; \
    done; \
    test "$i" -le 5

# Copy source code
COPY . .

# Build the application
RUN npm run build

# Production stage
# Use a tiny Node server:
# - serves static assets
# - proxies `/api/*` -> solver (same-origin API on HTTPS)
FROM node:18-alpine

WORKDIR /app

# Copy built assets + server
COPY --from=builder /app/dist /app/dist
COPY server.cjs /app/server.cjs

EXPOSE 80

CMD ["node", "server.cjs"]
