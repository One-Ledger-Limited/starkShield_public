import { useCallback } from 'react';
import { apiClient } from '../../lib/api-client';
import { keccak256, toUtf8Bytes } from 'ethers';

type IntentStatusValue =
  | 'pending'
  | 'matched'
  | 'settled'
  | 'cancelled'
  | 'expired'
  | 'failed';

function normalizeAddress(address: string): string {
  // Canonicalize as 0x + 64 hex chars (lowercase) so different zero-padding from wallets
  // doesn't split local history keys.
  const trimmed = address.trim().toLowerCase();
  if (!trimmed.startsWith('0x')) return trimmed;
  const hex = trimmed.slice(2).replace(/^0+/, '') || '0';
  return `0x${hex.padStart(64, '0')}`;
}

interface ProofOutput {
  intent_hash: string;
  nullifier: string;
  proof_data: string[];
  public_inputs: string[];
}

interface SubmitIntentParams {
  proof: ProofOutput;
  userAddress: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  minAmountOut: string;
  deadline: number;
}

interface IntentView {
  id: string;
  nullifier: string;
  user: string;
  status: IntentStatusValue;
  created_at: string;
  expires_at: string;
  matched_with?: string | null;
  settlement_tx_hash?: string | null;
}

interface Intent {
  nullifier: string;
  status: IntentStatusValue;
  timestamp: number;
  tokenIn?: string;
  tokenOut?: string;
  amountIn?: string;
  expectedOut?: string;
}

interface IntentQueryResponse {
  intent?: IntentView | null;
}

interface PendingIntentResponse {
  id: string;
  nullifier: string;
  user: string;
  status: IntentStatusValue;
  created_at: string;
  expires_at: string;
  matched_with?: string | null;
  settlement_tx_hash?: string | null;
}

function historyKey(address: string): string {
  return `starkshield:intents:${normalizeAddress(address)}`;
}

function readIntentHistory(address: string): string[] {
  try {
    const raw = localStorage.getItem(historyKey(address));
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function writeIntentHistory(address: string, nullifier: string): void {
  const existing = readIntentHistory(address);
  if (existing.includes(nullifier)) {
    return;
  }
  const next = [nullifier, ...existing].slice(0, 100);
  localStorage.setItem(historyKey(address), JSON.stringify(next));
}

function getNextNonce(address: string): number {
  const key = `starkshield:nonce:${normalizeAddress(address)}`;
  const current = Number(localStorage.getItem(key) ?? '0');
  const next = Number.isFinite(current) && current >= 0 ? current + 1 : 1;
  localStorage.setItem(key, String(next));
  return next;
}

function toUnixSeconds(iso: string): number {
  const millis = Date.parse(iso);
  return Number.isNaN(millis) ? Math.floor(Date.now() / 1000) : Math.floor(millis / 1000);
}

export const useDarkPool = () => {
  const buildIntentSignature = useCallback(
    (userAddress: string, nullifier: string, nonce: number, deadline: number): string => {
      const payload = `${userAddress.toLowerCase()}:${nullifier.toLowerCase()}:${nonce}:${deadline}`;
      return keccak256(toUtf8Bytes(payload));
    },
    []
  );

  const submitIntent = useCallback(async (params: SubmitIntentParams): Promise<void> => {
    const { proof, userAddress, tokenIn, tokenOut, amountIn, minAmountOut, deadline } = params;
    const nonce = getNextNonce(userAddress);
    const chainId = import.meta.env.VITE_CHAIN_ID ?? 'SN_SEPOLIA';
    const domainSeparator = import.meta.env.VITE_DOMAIN_SEPARATOR ?? 'starkshield-hackathon';

    const payload = {
      intent_hash: proof.intent_hash,
      nullifier: proof.nullifier,
      proof_data: proof.proof_data,
      public_inputs: {
        user: userAddress,
        token_in: tokenIn,
        token_out: tokenOut,
        amount_in: amountIn,
        min_amount_out: minAmountOut,
        deadline,
        nonce,
        chain_id: chainId,
        domain_separator: domainSeparator,
        version: 1,
      },
      encrypted_details: btoa(
        JSON.stringify({
          tokenIn,
          tokenOut,
          amountIn,
          minAmountOut,
        })
      ),
      signature: buildIntentSignature(userAddress, proof.nullifier, nonce, deadline),
    };

    await apiClient.post('/v1/intents', payload);
    writeIntentHistory(userAddress, proof.nullifier);
  }, [buildIntentSignature]);

  const getIntentStatus = useCallback(async (nullifier: string): Promise<string> => {
    const { data } = await apiClient.get<IntentQueryResponse>(`/v1/intents/${nullifier}`);
    return data.intent?.status ?? 'unknown';
  }, []);

  const cancelIntent = useCallback(async (nullifier: string): Promise<void> => {
    await apiClient.post(`/v1/intents/${nullifier}/cancel`);
  }, []);

  const getUserIntents = useCallback(async (userAddress: string): Promise<Intent[]> => {
    // Primary: fetch full intent history for this user from the solver (works across devices/browsers).
    try {
      const { data } = await apiClient.get<PendingIntentResponse[]>('/v1/intents/by-user', {
        params: { user: userAddress },
      });
      const mapped = data
        .map((intent) => ({
          nullifier: intent.nullifier,
          status: intent.status,
          timestamp: toUnixSeconds(intent.created_at),
        }))
        .sort((a, b) => b.timestamp - a.timestamp);

      // Compatibility: older deployments may have pending intents that were never indexed into
      // the by-user set. If by-user returns empty, fall back to pending for this user.
      if (mapped.length > 0) return mapped;
    } catch {
      // Fallback: at least show currently pending ones (older solvers may not support by-user).
      // Ignore and try pending below.
    }

    const { data } = await apiClient.get<PendingIntentResponse[]>('/v1/intents/pending', {
      params: { user: userAddress },
    });
    return data
      .map((intent) => ({
        nullifier: intent.nullifier,
        status: intent.status,
        timestamp: toUnixSeconds(intent.created_at),
      }))
      .sort((a, b) => b.timestamp - a.timestamp);
  }, []);

  return {
    submitIntent,
    getIntentStatus,
    cancelIntent,
    getUserIntents,
    isReady: true,
  };
};
