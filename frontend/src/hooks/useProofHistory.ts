import { useCallback, useEffect, useMemo, useState } from 'react';

export interface ProofHistoryItemV1 {
  id: string;
  createdAtMs: number;
  provingTimeMs: number;
  intentHash: string;
  nullifier: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  minAmountOut: string;
  deadline: number;
}

const STORAGE_KEY = 'starkshield.proofs.v1';
const EVENT_NAME = 'starkshield:proofs';

function safeRead(): ProofHistoryItemV1[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(Boolean) as ProofHistoryItemV1[];
  } catch {
    return [];
  }
}

function safeWrite(next: ProofHistoryItemV1[]) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    // Same-tab updates: `storage` does not fire; emit an app event.
    window.dispatchEvent(new Event(EVENT_NAME));
  } catch {
    // ignore quota/serialization errors; history is best-effort
  }
}

export function useProofHistory() {
  const [items, setItems] = useState<ProofHistoryItemV1[]>(() => safeRead());

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setItems(safeRead());
    };
    const onEvent = () => setItems(safeRead());
    window.addEventListener('storage', onStorage);
    window.addEventListener(EVENT_NAME, onEvent);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener(EVENT_NAME, onEvent);
    };
  }, []);

  const add = useCallback((item: ProofHistoryItemV1) => {
    const curr = safeRead();
    const next = [item, ...curr].slice(0, 50);
    safeWrite(next);
    setItems(next);
  }, []);

  const clear = useCallback(() => {
    safeWrite([]);
    setItems([]);
  }, []);

  const stats = useMemo(() => {
    const count = items.length;
    const avgProvingTimeMs =
      count === 0
        ? 0
        : Math.round(
            items.reduce((acc: number, it: ProofHistoryItemV1) => acc + (it.provingTimeMs || 0), 0) / count,
          );
    return { count, avgProvingTimeMs };
  }, [items]);

  return { items, add, clear, stats };
}
