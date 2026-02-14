# API Documentation

## Base URL

```
Production: https://api.starkshield.io
Staging: https://api-staging.starkshield.io
Local: http://localhost:8080
```

## Authentication

`GET /health` and `GET /v1/health` are public.

All other write/read intent endpoints require Bearer JWT:

```http
Authorization: Bearer <token>
```

Get token via:

```http
POST /v1/auth/login
Content-Type: application/json
```

```json
{
  "username": "admin",
  "password": "<your-password>"
}
```

## Endpoints

### Health Check

Check if the solver is running and healthy.

```http
GET /health
```

**Response:**
```json
{
  "status": "healthy",
  "version": "0.1.0",
  "uptime_seconds": 3600,
  "pending_intents": 42,
  "matched_pairs": 15
}
```

### Submit Intent

Submit a new trade intent with ZK proof.

```http
POST /intent
Content-Type: application/json
```

**Request Body:**
```json
{
  "intent_hash": "0x1234567890abcdef...",
  "nullifier": "0xabcdef1234567890...",
  "proof_data": [
    "12345678901234567890",
    "09876543210987654321",
    "...",
    "..."
  ],
  "public_inputs": {
    "user": "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7",
    "token_in": "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7",
    "token_out": "0x053c91253bc9682c04929ca02ed00b3e423f6710d2ee7e0d5ebb06f3ecf368a8",
    "amount_in": "1000000000000000000",
    "min_amount_out": "3000000000",
    "deadline": 1704067200
  },
  "encrypted_details": "base64_encoded_encrypted_intent_data",
  "signature": "user_signature_over_intent_hash"
}
```

**Response:**
```json
{
  "intent_id": "uuid-of-intent",
  "status": "pending",
  "estimated_match_time": "< 30 seconds"
}
```

**Error Responses:**
- `400 Bad Request`: Invalid proof or parameters
- `409 Conflict`: Intent already exists
- `429 Too Many Requests`: Rate limit exceeded
- `500 Internal Server Error`: Server error

### Query Intent

Get the status of a specific intent.

```http
GET /intent/{nullifier}
```

**Response:**
```json
{
  "intent": {
    "id": "uuid-of-intent",
    "nullifier": "0xabcdef1234567890...",
    "status": "pending",
    "created_at": "2024-01-01T12:00:00Z",
    "expires_at": "2024-01-01T13:00:00Z",
    "matched_with": null,
    "settlement_tx_hash": null
  }
}
```

**Status Values:**
- `pending`: Awaiting match
- `matched`: Paired with counterparty
- `settled`: Successfully executed
- `cancelled`: User cancelled
- `expired`: Past deadline

### Get Pending Intents

Get all pending intents (public information only).

```http
GET /intents/pending
```

**Response:**
```json
[
  {
    "id": "uuid-1",
    "nullifier": "0xabc...",
    "status": "pending",
    "created_at": "2024-01-01T12:00:00Z",
    "expires_at": "2024-01-01T13:00:00Z"
  },
  {
    "id": "uuid-2",
    "nullifier": "0xdef...",
    "status": "pending",
    "created_at": "2024-01-01T12:05:00Z",
    "expires_at": "2024-01-01T13:05:00Z"
  }
]
```

### Get Statistics

Get solver statistics.

```http
GET /stats
```

**Response:**
```json
{
  "pending_intents": 42,
  "matched_pairs": 15
}
```

## WebSocket API

Real-time updates via WebSocket (coming in Phase 2).

```
wss://api.starkshield.io/ws
```

### Subscribe to Intent Updates

```json
{
  "action": "subscribe",
  "nullifier": "0xabcdef1234567890..."
}
```

### Events

#### Intent Matched
```json
{
  "event": "matched",
  "nullifier": "0xabcdef1234567890...",
  "matched_with": "0x1234567890abcdef...",
  "timestamp": "2024-01-01T12:01:00Z"
}
```

#### Intent Settled
```json
{
  "event": "settled",
  "nullifier": "0xabcdef1234567890...",
  "transaction_hash": "0x...",
  "timestamp": "2024-01-01T12:02:00Z"
}
```

## Error Handling

All errors follow this format:

```json
{
  "success": false,
  "error": "Human-readable error message",
  "code": "ERROR_CODE",
  "error_detail": {
    "code": "ERROR_CODE",
    "message": "Human-readable error message"
  }
}
```

### Error Codes

| Code | Description |
|------|-------------|
| `INVALID_PROOF` | ZK proof validation failed |
| `INVALID_ENCODING` | Base64 decoding failed |
| `DUPLICATE_INTENT` | Intent with this nullifier already exists |
| `INTENT_NOT_FOUND` | Intent does not exist |
| `QUERY_ERROR` | Database query failed |
| `STORAGE_ERROR` | Failed to store intent |
| `STATS_ERROR` | Failed to retrieve statistics |
| `RATE_LIMITED` | Too many requests |

## Rate Limiting

- 60 requests per minute per IP address
- WebSocket: 100 messages per minute per connection

Rate limit headers:
```
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 59
X-RateLimit-Reset: 1704067260
```

## SDK Examples

### JavaScript/TypeScript

```typescript
import { StarkShieldClient } from '@starkshield/sdk';

const client = new StarkShieldClient({
  baseURL: 'https://api.starkshield.io'
});

// Submit intent
const result = await client.submitIntent({
  intent_hash: '0x...',
  nullifier: '0x...',
  proof_data: [...],
  public_inputs: {...},
  encrypted_details: '...',
  signature: '...'
});

// Poll for status
const status = await client.getIntentStatus(nullifier);
```

### Python

```python
import requests

BASE_URL = "https://api.starkshield.io"

# Submit intent
response = requests.post(f"{BASE_URL}/intent", json={
    "intent_hash": "0x...",
    "nullifier": "0x...",
    # ... other fields
})

result = response.json()
```

### cURL

```bash
# Submit intent
curl -X POST https://api.starkshield.io/intent \
  -H "Content-Type: application/json" \
  -d '{
    "intent_hash": "0x...",
    "nullifier": "0x...",
    "proof_data": [...],
    "public_inputs": {...}
  }'

# Query intent
curl https://api.starkshield.io/intent/{nullifier}
```

## Versioning

The API is versioned via URL path:

```
/v1/health
/v1/intent
```

Current version: v1

## Changelog

### v1.0.0 (2024-01-01)
- Initial API release
- Intent submission and querying
- Health checks and statistics
