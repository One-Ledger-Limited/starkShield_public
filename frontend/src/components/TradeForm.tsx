import React, { useEffect, useMemo, useState } from 'react';
import { useAccount } from '@starknet-react/core';
import { useDarkPool } from '../hooks/useDarkPool';
import { useZKProof } from '../hooks/useZKProof';
import { ArrowRight, Loader2, Shield } from 'lucide-react';
import { toUserErrorMessage } from '../constants/error-messages';
import { apiClient } from '../../lib/api-client';
import {
  computeImpliedSlippagePercentSameToken,
  computeMinExchangeRate,
  formatPercent,
  formatRate,
} from '../utils/trade-metrics';
import { fetchPragmaTwap } from '../../lib/pragma-twap';
import { useProofHistory } from '../hooks/useProofHistory';
import { useFlowProgress } from '../hooks/useFlowProgress';
import { parseUnits } from 'ethers';
import { hash } from 'starknet';

interface TradeParams {
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  minAmountOut: string;
  deadline: number;
}

const DRAFT_KEY = 'starkshield.draft_intent.v1';

type DraftIntentV1 = {
  user: string;
  tradeParams: TradeParams;
  proofData: any;
  createdAtMs: number;
};

type Uint256Like = { low: string; high: string } | { balance: { low: string; high: string } };

function asUint256(v: any): { low: string; high: string } {
  if (!v) throw new Error('Missing uint256 response');
  if (typeof v === 'object' && typeof v.low !== 'undefined' && typeof v.high !== 'undefined') {
    return { low: String(v.low), high: String(v.high) };
  }
  if (typeof v === 'object' && v.balance && typeof v.balance.low !== 'undefined' && typeof v.balance.high !== 'undefined') {
    return { low: String(v.balance.low), high: String(v.balance.high) };
  }
  if (Array.isArray(v) && v.length >= 2) {
    return { low: String(v[0]), high: String(v[1]) };
  }
  throw new Error('Unexpected uint256 response shape');
}

function uint256ToBigInt(u: Uint256Like): bigint {
  const { low, high } = asUint256(u as any);
  return BigInt(low) + (BigInt(high) << 128n);
}

async function starknetCall(
  contractAddress: string,
  entrypoint: string,
  calldata: string[],
): Promise<any> {
  const payload = {
    jsonrpc: '2.0',
    id: Date.now(),
    method: 'starknet_call',
    params: [
      {
        contract_address: contractAddress,
        entry_point_selector: hash.getSelectorFromName(entrypoint),
        calldata,
      },
      'latest',
    ],
  };
  const { data } = await apiClient.post<any>('/v1/starknet-rpc', payload);
  if (!data || typeof data !== 'object' || data.jsonrpc !== '2.0') {
    throw new Error('RPC proxy returned invalid response (expected JSON-RPC 2.0).');
  }
  if (data.error) {
    throw new Error(data.error?.message ?? 'Starknet RPC returned error');
  }
  return data?.result;
}

function safeReadDraft(): DraftIntentV1 | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DraftIntentV1;
    if (!parsed || typeof parsed !== 'object') return null;
    if (!parsed.user || !parsed.tradeParams || !parsed.proofData) return null;
    return parsed;
  } catch {
    return null;
  }
}

function safeWriteDraft(draft: DraftIntentV1) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // best-effort
  }
}

function safeClearDraft() {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(DRAFT_KEY);
  } catch {
    // best-effort
  }
}

function normalizeAddress(address: string): string {
  const trimmed = address.trim().toLowerCase();
  if (!trimmed.startsWith('0x')) return trimmed;
  const hex = trimmed.slice(2).replace(/^0+/, '') || '0';
  return `0x${hex.padStart(64, '0')}`;
}

const COMMON_TOKENS = [
  { symbol: 'ETH', address: '0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7' },
  { symbol: 'STRK', address: '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d' },
  { symbol: 'USDC', address: '0x053c91253bc9682c04929ca02ed00b3e423f6710d2ee7e0d5ebb06f3ecf368a8' },
  { symbol: 'USDT', address: '0x068f5c6a61780768455de69077e07e89787839bf8166decfbf92b645209c0fb8' },
  { symbol: 'DAI', address: '0x00da114221cb83fa859dbdb4c44beeaa0bb37c7537ad5ae66fe5e0efd20e6eb3' },
] as const;

const TOKEN_SYMBOL_BY_ADDRESS = new Map<string, string>(COMMON_TOKENS.map((t) => [t.address, t.symbol]));
const TWAP_PAIR_BY_SYMBOL: Record<string, string> = {
  ETH: 'ETH/USD',
  STRK: 'STRK/USD',
  USDC: 'USDC/USD',
  USDT: 'USDT/USD',
  DAI: 'DAI/USD',
};

function getTokenSymbol(tokenAddress: string): string {
  return TOKEN_SYMBOL_BY_ADDRESS.get(tokenAddress) ?? 'Token';
}

export const TradeForm: React.FC = () => {
  const { address, account } = useAccount();
  const { submitIntent } = useDarkPool();
  const { generateProof, isGenerating } = useZKProof();
  const proofHistory = useProofHistory();
  const flow = useFlowProgress();

  const requireLogin =
    (import.meta.env.VITE_REQUIRE_LOGIN as string | undefined)?.toLowerCase() === 'true';
  
  const [tradeParams, setTradeParams] = useState<TradeParams>({
    tokenIn: '',
    tokenOut: '',
    amountIn: '',
    minAmountOut: '',
    deadline: Math.floor(Date.now() / 1000) + 3600, // 1 hour from now
  });
  
  const [proofData, setProofData] = useState<any>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [precheckLoading, setPrecheckLoading] = useState(false);
  const [precheckMessage, setPrecheckMessage] = useState<string | null>(null);
  const [needsApproval, setNeedsApproval] = useState(false);
  const [approveLoading, setApproveLoading] = useState(false);
  const [autoSubmitAfterApprove, setAutoSubmitAfterApprove] = useState(false);

  const isAuthed = Boolean(localStorage.getItem('token')) || !requireLogin;
  const actionBusy = isSubmitting || precheckLoading || approveLoading || autoSubmitAfterApprove;
  const submitDisabled = actionBusy || needsApproval || (requireLogin && !isAuthed);
  const approveDisabled = actionBusy;

  // If user navigates away after generating a proof (without submitting),
  // restore the last draft when coming back to this tab.
  useEffect(() => {
    if (!address) return;
    if (proofData) return;
    const draft = safeReadDraft();
    if (!draft) return;
    if (normalizeAddress(draft.user) !== normalizeAddress(address)) return;
    const nowSec = Math.floor(Date.now() / 1000);
    // If the draft deadline is already in the past (or about to expire), force the user to
    // regenerate a fresh proof with a new deadline. Otherwise, the backend will reject it.
    if (draft.tradeParams.deadline <= nowSec + 5) {
      setTradeParams({
        ...draft.tradeParams,
        deadline: nowSec + 3600,
      });
      setProofData(null);
      safeClearDraft();
      setErrorMessage('交易意圖已過期，請重新建立交易。');
      return;
    }

    setTradeParams(draft.tradeParams);
    setProofData(draft.proofData);
  }, [address]);

  const handleGenerateProof = async () => {
    setErrorMessage(null);
    setSuccessMessage(null);
    if (!address) {
      setErrorMessage('Please connect wallet first');
      return;
    }
    try {
      const startedAt = Date.now();
      const proof = await generateProof({
        user: address,
        tokenIn: tradeParams.tokenIn,
        tokenOut: tradeParams.tokenOut,
        amountIn: tradeParams.amountIn,
        minAmountOut: tradeParams.minAmountOut,
        deadline: tradeParams.deadline,
      });
      
      setProofData(proof);
      const provingTimeMs = Math.max(0, Date.now() - startedAt);
      safeWriteDraft({
        user: address,
        tradeParams,
        proofData: proof,
        createdAtMs: Date.now(),
      });
      proofHistory.add({
        id: `proof_${Date.now()}`,
        createdAtMs: Date.now(),
        provingTimeMs,
        intentHash: proof.intent_hash,
        nullifier: proof.nullifier,
        tokenIn: tradeParams.tokenIn,
        tokenOut: tradeParams.tokenOut,
        amountIn: tradeParams.amountIn,
        minAmountOut: tradeParams.minAmountOut,
        deadline: tradeParams.deadline,
      });
      flow.markProofCreated();
    } catch (error) {
      console.error('Failed to generate proof:', error);
      setErrorMessage(toUserErrorMessage(error));
    }
  };

  const handleSubmitIntent = async () => {
    setErrorMessage(null);
    setSuccessMessage(null);
    setPrecheckMessage(null);
    if (requireLogin && !isAuthed) {
      setErrorMessage('Please login first');
      return;
    }
    if (!proofData) {
      setErrorMessage('Please generate a proof first');
      return;
    }
    if (!address) {
      setErrorMessage('Please connect wallet first');
      return;
    }
    const nowSec = Math.floor(Date.now() / 1000);
    if (tradeParams.deadline <= nowSec + 5) {
      setErrorMessage('交易意圖已過期，請重新建立交易。');
      setProofData(null);
      safeClearDraft();
      return;
    }

    // Balance/allowance precheck against Starknet ERC20 (best-effort UX + backend enforcement).
    if (tradeParams.tokenIn && tradeParams.amountIn) {
      setPrecheckLoading(true);
      setNeedsApproval(false);
      try {
        const tokenIn = tradeParams.tokenIn;
        const spender = (import.meta.env.VITE_DARK_POOL_ADDRESS as string | undefined) ?? '';

        const decimalsResult = await starknetCall(tokenIn, 'decimals', []);
        const decimals = decimalsResult?.[0] ? Number(BigInt(decimalsResult[0])) : 18;
        const required = parseUnits(tradeParams.amountIn, Number.isFinite(decimals) ? decimals : 18);

        const balRes = await starknetCall(tokenIn, 'balanceOf', [address]);
        const balance = uint256ToBigInt(balRes);
        if (balance < required) {
          setPrecheckMessage('Insufficient token balance for amount_in.');
          setErrorMessage('Insufficient token balance for amount_in.');
          return;
        }

        if (spender) {
          const allowanceRes = await starknetCall(tokenIn, 'allowance', [address, spender]);
          const allowance = uint256ToBigInt(allowanceRes);
          if (allowance < required) {
            setPrecheckMessage('Insufficient allowance. Please approve the Dark Pool contract before submitting.');
            setErrorMessage('Insufficient allowance. Please approve the Dark Pool contract before submitting.');
            setNeedsApproval(true);
            return;
          }
        }
      } catch (e) {
        // Don't hard-block on RPC issues; backend may still enforce depending on config.
        setPrecheckMessage(`Unable to run balance/allowance precheck (RPC): ${toUserErrorMessage(e)}`);
      } finally {
        setPrecheckLoading(false);
      }
    }

    setIsSubmitting(true);
    try {
      await submitIntent({
        proof: proofData,
        userAddress: address,
        tokenIn: tradeParams.tokenIn,
        tokenOut: tradeParams.tokenOut,
        amountIn: tradeParams.amountIn,
        minAmountOut: tradeParams.minAmountOut,
        deadline: tradeParams.deadline,
      });
      setSuccessMessage('Intent submitted successfully.');
      flow.markIntentSubmitted();
      
      // Reset form
      setTradeParams({
        tokenIn: '',
        tokenOut: '',
        amountIn: '',
        minAmountOut: '',
        deadline: Math.floor(Date.now() / 1000) + 3600,
      });
      setProofData(null);
      safeClearDraft();
    } catch (error) {
      console.error('Failed to submit intent:', error);
      setErrorMessage(toUserErrorMessage(error));
    } finally {
      setIsSubmitting(false);
    }
  };

  // If user clicks approve, the tx is async and RPC state may take a while to reflect the new allowance.
  // Poll allowance and auto-submit once it updates, so users don't get stuck after seeing on-chain approval.
  useEffect(() => {
    if (!autoSubmitAfterApprove) return;
    if (!address) return;
    if (!proofData) return;
    if (!tradeParams.tokenIn || !tradeParams.amountIn) return;
    const spender = (import.meta.env.VITE_DARK_POOL_ADDRESS as string | undefined) ?? '';
    if (!spender) return;

    let cancelled = false;
    let attempts = 0;
    const maxAttempts = 30; // ~60s

    const run = async () => {
      while (!cancelled && attempts < maxAttempts) {
        attempts += 1;
        try {
          const decimalsResult = await starknetCall(tradeParams.tokenIn, 'decimals', []);
          const decimals = decimalsResult?.[0] ? Number(BigInt(decimalsResult[0])) : 18;
          const required = parseUnits(tradeParams.amountIn, Number.isFinite(decimals) ? decimals : 18);

          const allowanceRes = await starknetCall(tradeParams.tokenIn, 'allowance', [address, spender]);
          const allowance = uint256ToBigInt(allowanceRes);
          if (allowance >= required) {
            setAutoSubmitAfterApprove(false);
            setNeedsApproval(false);
            setPrecheckMessage('Allowance updated. Submitting intent...');
            await handleSubmitIntent();
            return;
          }
        } catch {
          // ignore and retry
        }

        await new Promise((r) => setTimeout(r, 2000));
      }

      if (!cancelled) {
        setAutoSubmitAfterApprove(false);
        setPrecheckMessage('Approval submitted, but allowance has not updated yet. Please wait and click Submit again.');
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [address, autoSubmitAfterApprove, handleSubmitIntent, proofData, tradeParams.amountIn, tradeParams.tokenIn]);

  const [twapSlippagePercent, setTwapSlippagePercent] = useState<number | null>(null);
  const [twapLoading, setTwapLoading] = useState(false);
  const [twapError, setTwapError] = useState<string | null>(null);
  const [twapPairKey, setTwapPairKey] = useState<string>('');

  const slippageInputs = useMemo(() => {
    if (!tradeParams.tokenIn || !tradeParams.tokenOut) return null;
    if (!tradeParams.amountIn || !tradeParams.minAmountOut) return null;
    const amountIn = Number(tradeParams.amountIn);
    const minOut = Number(tradeParams.minAmountOut);
    if (!Number.isFinite(amountIn) || !Number.isFinite(minOut) || amountIn <= 0 || minOut <= 0) return null;
    return { amountIn, minOut };
  }, [tradeParams.amountIn, tradeParams.minAmountOut, tradeParams.tokenIn, tradeParams.tokenOut]);

  useEffect(() => {
    let cancelled = false;

    if (!slippageInputs) return;
    if (tradeParams.tokenIn === tradeParams.tokenOut) return;

    const inSym = getTokenSymbol(tradeParams.tokenIn);
    const outSym = getTokenSymbol(tradeParams.tokenOut);
    const inPair = TWAP_PAIR_BY_SYMBOL[inSym];
    const outPair = TWAP_PAIR_BY_SYMBOL[outSym];
    if (!inPair || !outPair) return;

    const nextPairKey = `${tradeParams.tokenIn}->${tradeParams.tokenOut}`;
    if (nextPairKey !== twapPairKey) {
      setTwapPairKey(nextPairKey);
      setTwapSlippagePercent(null);
    }

    const t = setTimeout(async () => {
      setTwapError(null);
      setTwapLoading(true);
      try {
        const [inUsd, outUsd] = await Promise.all([fetchPragmaTwap(inPair), fetchPragmaTwap(outPair)]);

        // expectedOut = amountIn * (tokenInUSD / tokenOutUSD)
        const expectedOut = slippageInputs.amountIn * (inUsd.price / outUsd.price);
        const raw = (1 - slippageInputs.minOut / expectedOut) * 100;
        const pct = Number.isFinite(raw) ? Math.max(0, raw) : null;

        if (!cancelled) setTwapSlippagePercent(pct);
      } catch (e) {
        if (!cancelled) {
          setTwapError('Unable to fetch TWAP price (Pragma).');
        }
      } finally {
        if (!cancelled) setTwapLoading(false);
      }
    }, 400);

    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [
    slippageInputs,
    tradeParams.tokenIn,
    tradeParams.tokenOut,
  ]);

  return (
    <div className="space-y-6">
      {errorMessage && (
        <div className="rounded-lg border border-red-500/30 bg-red-600/10 px-4 py-3 text-sm text-red-200">
          {errorMessage}
        </div>
      )}
      {successMessage && (
        <div className="rounded-lg border border-green-500/30 bg-green-600/10 px-4 py-3 text-sm text-green-200">
          {successMessage}
        </div>
      )}
      <div className="bg-purple-600/10 border border-purple-500/30 rounded-lg p-4">
        <div className="flex items-start space-x-3">
          <Shield className="w-5 h-5 text-purple-400 mt-0.5" />
          <div>
            <h4 className="text-purple-300 font-medium">Private Trade Intent</h4>
            <p className="text-sm text-gray-400 mt-1">
              Your trade details will be encrypted as a ZK proof. 
              No one (including solvers) can see your order details until settlement.
            </p>
          </div>
        </div>
      </div>

      {/* Token Selection */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-2">
            Token to Sell
          </label>
          <select
            value={tradeParams.tokenIn}
            onChange={(e) => setTradeParams({ ...tradeParams, tokenIn: e.target.value })}
            className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-3 text-white focus:outline-none focus:border-purple-500"
          >
            <option value="">Select token</option>
            {COMMON_TOKENS.map((token) => (
              <option key={token.address} value={token.address}>
                {token.symbol}
              </option>
            ))}
          </select>
        </div>
        
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-2">
            Token to Buy
          </label>
          <select
            value={tradeParams.tokenOut}
            onChange={(e) => setTradeParams({ ...tradeParams, tokenOut: e.target.value })}
            className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-3 text-white focus:outline-none focus:border-purple-500"
          >
            <option value="">Select token</option>
            {COMMON_TOKENS.map((token) => (
              <option key={token.address} value={token.address}>
                {token.symbol}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Amount Inputs */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-2">
            Amount to Sell
          </label>
          <input
            type="text"
            value={tradeParams.amountIn}
            onChange={(e) => setTradeParams({ ...tradeParams, amountIn: e.target.value })}
            placeholder="0.0"
            className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-purple-500"
          />
        </div>
        
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-2">
            Minimum to Receive
          </label>
          <input
            type="text"
            value={tradeParams.minAmountOut}
            onChange={(e) => setTradeParams({ ...tradeParams, minAmountOut: e.target.value })}
            placeholder="0.0"
            className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-purple-500"
          />
        </div>
      </div>

      {/* Slippage Warning */}
      {tradeParams.amountIn && tradeParams.minAmountOut && tradeParams.tokenIn && tradeParams.tokenOut && (
        <div className="bg-yellow-600/10 border border-yellow-500/30 rounded-lg p-3">
          <p className="text-sm text-yellow-300">
            {tradeParams.tokenIn === tradeParams.tokenOut ? (
              (() => {
                const implied = computeImpliedSlippagePercentSameToken(
                  tradeParams.amountIn,
                  tradeParams.minAmountOut,
                );
                return `Slippage tolerance (implied): ${implied === null ? '0.00' : formatPercent(implied)}%`;
              })()
            ) : (
              (() => {
                const rate = computeMinExchangeRate(tradeParams.amountIn, tradeParams.minAmountOut);
                const inSym = getTokenSymbol(tradeParams.tokenIn);
                const outSym = getTokenSymbol(tradeParams.tokenOut);
                const baseParts: string[] = [];
                baseParts.push(
                  `Minimum to receive: ${tradeParams.minAmountOut} ${outSym} (for ${tradeParams.amountIn} ${inSym})`,
                );
                if (rate !== null) {
                  const rateStr = formatRate(rate);
                  let extra = `Implied min rate: ${rateStr} ${outSym}/${inSym}`;
                  // If the implied rate is very large/small, also show the reciprocal to reduce confusion.
                  if (rate >= 100 || rate <= 0.01) {
                    const inv = 1 / rate;
                    if (Number.isFinite(inv) && inv > 0) {
                      extra += ` (${formatRate(inv)} ${inSym}/${outSym})`;
                    }
                  }
                  baseParts.push(extra);
                }
                const base = baseParts.join(' | ');

                if (twapLoading) return `${base} (TWAP loading...)`;
                if (twapError) return `${base} (${twapError})`;
                if (twapSlippagePercent !== null) {
                  const pct = formatPercent(twapSlippagePercent);
                  const hint = twapSlippagePercent >= 50
                    ? ' (Very high: increase Minimum to Receive or reduce Amount to Sell.)'
                    : '';
                  return `${base} | Slippage tolerance (vs oracle): ${pct}%${hint}`;
                }
                return base;
              })()
            )}
          </p>
        </div>
      )}

      {/* Action Buttons */}
      <div className="space-y-3">
        {precheckMessage && (
          <div className="rounded-lg border border-yellow-500/30 bg-yellow-600/10 px-4 py-3 text-sm text-yellow-200">
            {precheckMessage}
          </div>
        )}
        {!proofData ? (
          <button
            onClick={handleGenerateProof}
            disabled={!tradeParams.tokenIn || !tradeParams.tokenOut || !tradeParams.amountIn || isGenerating}
            className="w-full bg-purple-600 hover:bg-purple-700 disabled:bg-gray-700 disabled:cursor-not-allowed text-white font-medium py-4 rounded-lg transition flex items-center justify-center space-x-2"
          >
            {isGenerating ? (
              <>
                <Loader2 className="w-5 h-5 animate-spin" />
                <span>Generating ZK Proof...</span>
              </>
            ) : (
              <>
                <Shield className="w-5 h-5" />
                <span>Generate ZK Proof</span>
              </>
            )}
          </button>
        ) : (
          <div className="space-y-3">
            <div className="bg-green-600/10 border border-green-500/30 rounded-lg p-4">
              <div className="flex items-center space-x-2 text-green-400">
                <Shield className="w-5 h-5" />
                <span className="font-medium">Proof Generated Successfully</span>
              </div>
              <p className="text-sm text-gray-400 mt-1">
                Nullifier: {proofData.nullifier.slice(0, 20)}...
              </p>
            </div>
	            
	            <button
	              onClick={handleSubmitIntent}
	              disabled={submitDisabled}
	              className="w-full bg-green-600 hover:bg-green-700 disabled:bg-gray-700 disabled:cursor-not-allowed text-white font-medium py-4 rounded-lg transition flex items-center justify-center space-x-2"
	            >
	              {isSubmitting ? (
	                <>
	                  <Loader2 className="w-5 h-5 animate-spin" />
                  <span>Submitting Intent...</span>
                </>
              ) : precheckLoading ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  <span>Checking Balance...</span>
                </>
              ) : (
	                <>
	                  <ArrowRight className="w-5 h-5" />
	                  <span>
	                    {needsApproval
	                      ? 'Approval Required'
	                      : requireLogin && !isAuthed
	                        ? 'Login Required to Submit'
	                        : 'Submit Intent to Dark Pool'}
	                  </span>
	                </>
	              )}
	            </button>

            {needsApproval && Boolean((import.meta.env.VITE_DARK_POOL_ADDRESS as string | undefined)) && (
              <button
                onClick={async () => {
                  const tokenIn = tradeParams.tokenIn;
                  const spender = (import.meta.env.VITE_DARK_POOL_ADDRESS as string | undefined) ?? '';
                  if (!account) {
                    setErrorMessage('Please connect wallet to approve.');
                    return;
                  }
                  if (!tokenIn || !spender) {
                    setErrorMessage('Missing token/spender for approval.');
                    return;
                  }
                  try {
                    setApproveLoading(true);
                    setErrorMessage(null);
                    setPrecheckMessage(null);

                    const decimalsResult = await starknetCall(tokenIn, 'decimals', []);
                    const decimals = decimalsResult?.[0] ? Number(BigInt(decimalsResult[0])) : 18;
                    const required = parseUnits(tradeParams.amountIn, Number.isFinite(decimals) ? decimals : 18);
                    const low = required & ((1n << 128n) - 1n);
                    const high = required >> 128n;
                    const feltHex = (v: bigint) => `0x${v.toString(16)}`;

                    await (account as any).execute([
                      {
                        contractAddress: tokenIn,
                        entrypoint: 'approve',
                        calldata: [spender, feltHex(low), feltHex(high)],
                      },
                    ]);

                    setSuccessMessage('Approval transaction submitted. Waiting for allowance update...');
                    setAutoSubmitAfterApprove(true);
                  } catch (e) {
                    setErrorMessage(toUserErrorMessage(e));
	                  } finally {
	                    setApproveLoading(false);
	                  }
	                }}
	                disabled={approveDisabled}
	                className="w-full bg-yellow-600 hover:bg-yellow-700 disabled:bg-gray-700 disabled:cursor-not-allowed text-white font-medium py-3 rounded-lg transition flex items-center justify-center space-x-2"
	              >
	                {approveLoading ? (
	                  <>
                    <Loader2 className="w-5 h-5 animate-spin" />
                    <span>Approving...</span>
                  </>
                ) : (
                  <span>Approve Token for Dark Pool</span>
                )}
              </button>
            )}
            
            <button
              onClick={() => {
                setProofData(null);
                safeClearDraft();
              }}
              className="w-full bg-white/5 hover:bg-white/10 text-gray-300 font-medium py-3 rounded-lg transition"
            >
              Reset and Start Over
            </button>
          </div>
        )}
      </div>

      {/* Info */}
      <div className="text-center text-sm text-gray-500">
        <p>Your proof is generated locally and never leaves your device.</p>
        <p>Only the proof hash is shared with the solver network.</p>
      </div>
    </div>
  );
};
