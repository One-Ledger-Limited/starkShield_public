// Scarb expects a Cairo package entrypoint at `src/lib.cairo`.
// We keep contract sources at the repo root for simplicity and include them via paths.

#[path("../DarkPool.cairo")]
mod DarkPool;

#[path("../IntentVerifier.cairo")]
mod IntentVerifier;
