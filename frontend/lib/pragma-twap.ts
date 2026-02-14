import { apiClient } from './api-client';

function getTwapWindowSeconds(): number {
  const raw = import.meta.env.VITE_PRAGMA_TWAP_WINDOW_SECONDS;
  const n = raw ? Number(raw) : 3600;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 3600;
}

function feltLikeToBigInt(value: string): bigint {
  // `Felt::to_string()` can be hex (0x...) in starknet-rs; BigInt can parse both.
  return BigInt(value);
}

export interface PragmaTwapPrice {
  price: number; // normalized float
  decimals: number;
  raw: bigint;
}

export async function fetchPragmaTwap(pairId: string): Promise<PragmaTwapPrice> {
  const windowSeconds = getTwapWindowSeconds();
  const resp = await apiClient.get('/v1/prices/pragma/twap', {
    params: {
      pair_id: pairId,
      window_seconds: windowSeconds,
    },
  });

  const payload = resp.data as {
    success: boolean;
    pair_id: string;
    window_seconds: number;
    start_time: number;
    price_raw: string;
    decimals_raw: string;
  };

  if (!payload?.success) {
    throw new Error('Pragma TWAP request failed');
  }

  const raw = feltLikeToBigInt(payload.price_raw);
  const decimals = Number(feltLikeToBigInt(payload.decimals_raw));
  if (!Number.isFinite(decimals) || decimals < 0 || decimals > 36) {
    throw new Error('Invalid TWAP decimals');
  }

  const price = Number(raw.toString()) / 10 ** decimals;
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error('Invalid TWAP price');
  }

  return { raw, decimals, price };
}

