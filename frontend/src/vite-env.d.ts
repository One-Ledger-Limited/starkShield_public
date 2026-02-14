/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SOLVER_API_URL?: string;
  readonly VITE_RPC_URL?: string;
  readonly VITE_STARKNET_RPC?: string;
  readonly VITE_CHAIN_ID?: string;
  readonly VITE_DOMAIN_SEPARATOR?: string;
  readonly VITE_PRAGMA_SUMMARY_STATS_ADDRESS?: string;
  readonly VITE_PRAGMA_TWAP_WINDOW_SECONDS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
