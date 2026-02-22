/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SOLVER_API_URL?: string;
  readonly VITE_RPC_URL?: string;
  readonly VITE_STARKNET_RPC?: string;
  readonly VITE_CHAIN_ID?: string;
  readonly VITE_DARK_POOL_ADDRESS?: string;
  readonly VITE_REQUIRE_LOGIN?: string;
  readonly VITE_DOMAIN_SEPARATOR?: string;
  readonly VITE_PRAGMA_SUMMARY_STATS_ADDRESS?: string;
  readonly VITE_PRAGMA_TWAP_WINDOW_SECONDS?: string;
  readonly VITE_CIRCUIT_WASM_URL?: string;
  readonly VITE_CIRCUIT_ZKEY_URL?: string;
  readonly VITE_VERIFICATION_KEY_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
