import { useCallback, useEffect, useState } from 'react';

export interface FlowProgressV1 {
  lastProofAtMs?: number;
  lastIntentSubmittedAtMs?: number;
}

const STORAGE_KEY = 'starkshield.flow.v1';
const EVENT_NAME = 'starkshield:flow';

function safeRead(): FlowProgressV1 {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed as FlowProgressV1;
  } catch {
    return {};
  }
}

function safeWrite(next: FlowProgressV1) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    window.dispatchEvent(new Event(EVENT_NAME));
  } catch {
    // best-effort
  }
}

export function useFlowProgress() {
  const [progress, setProgress] = useState<FlowProgressV1>(() => safeRead());

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setProgress(safeRead());
    };
    const onEvent = () => setProgress(safeRead());
    window.addEventListener('storage', onStorage);
    window.addEventListener(EVENT_NAME, onEvent);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener(EVENT_NAME, onEvent);
    };
  }, []);

  const markProofCreated = useCallback(() => {
    const curr = safeRead();
    const next: FlowProgressV1 = { ...curr, lastProofAtMs: Date.now() };
    safeWrite(next);
    setProgress(next);
  }, []);

  const markIntentSubmitted = useCallback(() => {
    const curr = safeRead();
    const next: FlowProgressV1 = { ...curr, lastIntentSubmittedAtMs: Date.now() };
    safeWrite(next);
    setProgress(next);
  }, []);

  const reset = useCallback(() => {
    safeWrite({});
    setProgress({});
  }, []);

  return { progress, markProofCreated, markIntentSubmitted, reset };
}

