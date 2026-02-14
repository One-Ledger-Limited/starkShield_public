# Security Policy

## Reporting

If you discover a security issue, please **do not** open a public GitHub issue.  
Instead, contact the maintainers privately and include enough detail to reproduce.

## Secrets / Credentials

This repository is intended to be public. Do not commit:
- `.env` files
- private keys / seed phrases
- JWT secrets / API passwords
- SSH keys, certificates (`*.pem`, `*.key`)

Use environment variables for all sensitive configuration. See `.env.example`.

## Safe Defaults

If you enable auth (`REQUIRE_AUTH=true`), you must set:
- `JWT_SECRET`
- `AUTH_PASSWORD`

The solver will refuse to start with missing values to avoid shipping demo credentials.
