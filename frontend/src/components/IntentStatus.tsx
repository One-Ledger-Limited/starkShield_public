import React, { useEffect, useState } from 'react';
import { useAccount } from '@starknet-react/core';
import { useDarkPool } from '../hooks/useDarkPool';
import { Clock, CheckCircle, XCircle, Loader2 } from 'lucide-react';
import { toUserErrorMessage } from '../constants/error-messages';

interface Intent {
  nullifier: string;
  status: 'pending' | 'matched' | 'settled' | 'cancelled' | 'expired' | 'failed';
  timestamp: number;
  tokenIn?: string;
  tokenOut?: string;
  amountIn?: string;
  expectedOut?: string;
}

function normalizeAddress(address: string): string {
  const trimmed = address.trim().toLowerCase();
  if (!trimmed.startsWith('0x')) return trimmed;
  const hex = trimmed.slice(2).replace(/^0+/, '') || '0';
  return `0x${hex.padStart(64, '0')}`;
}

export const IntentStatus: React.FC = () => {
  const { address } = useAccount();
  const { getUserIntents, cancelIntent } = useDarkPool();
  const requireLogin =
    (import.meta.env.VITE_REQUIRE_LOGIN as string | undefined)?.toLowerCase() === 'true';
  const isAuthed = Boolean(localStorage.getItem('token')) || !requireLogin;
  const [intents, setIntents] = useState<Intent[]>([]);
  const [loading, setLoading] = useState(true);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [hasLocalDraft, setHasLocalDraft] = useState(false);

  useEffect(() => {
    const fetchIntents = async () => {
      if (requireLogin && !isAuthed) {
        setIntents([]);
        setLoading(false);
        return;
      }
      if (!address) {
        setIntents([]);
        setLoading(false);
        return;
      }
      
      try {
        const userIntents = await getUserIntents(address);
        setIntents(userIntents);
        setErrorMessage(null);
      } catch (error) {
        console.error('Failed to fetch intents:', error);
        setErrorMessage(toUserErrorMessage(error));
      } finally {
        setLoading(false);
      }
    };

    fetchIntents();
    const interval = setInterval(fetchIntents, 30000); // Refresh every 30s
    
    return () => clearInterval(interval);
  }, [address, getUserIntents, isAuthed, requireLogin]);

  useEffect(() => {
    if (!address) {
      setHasLocalDraft(false);
      return;
    }
    try {
      const raw = localStorage.getItem('starkshield.draft_intent.v1');
      if (!raw) {
        setHasLocalDraft(false);
        return;
      }
      const parsed = JSON.parse(raw) as { user?: string };
      setHasLocalDraft(Boolean(parsed?.user && normalizeAddress(parsed.user) === normalizeAddress(address)));
    } catch {
      setHasLocalDraft(false);
    }
  }, [address]);

  const handleCancel = async (nullifier: string) => {
    try {
      setCancelling(nullifier);
      await cancelIntent(nullifier);
      setErrorMessage(null);
      if (address) {
        const refreshed = await getUserIntents(address);
        setIntents(refreshed);
      }
    } catch (error) {
      console.error('Failed to cancel intent:', error);
      setErrorMessage(toUserErrorMessage(error));
    } finally {
      setCancelling(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-8 h-8 text-purple-400 animate-spin" />
      </div>
    );
  }

  if (intents.length === 0) {
    return (
      <div className="text-center py-12">
        <Clock className="w-12 h-12 text-gray-600 mx-auto mb-4" />
        <h3 className="text-lg font-medium text-white mb-2">
          {isAuthed ? 'No Active Intents' : requireLogin ? 'Login Required' : 'No Active Intents'}
        </h3>
        <p className="text-gray-400">
          {isAuthed
            ? "You haven't submitted any trade intents yet. Create one to get started."
            : requireLogin
              ? 'Please login to view and manage your intents.'
              : "You haven't submitted any trade intents yet. Create one to get started."}
        </p>
        {isAuthed && hasLocalDraft && (
          <p className="mt-3 text-sm text-yellow-300">
            You have a locally generated proof that is not submitted yet. Go back to "New Trade" and click "Submit Intent".
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h3 className="text-lg font-medium text-white mb-4">Your Trade Intents</h3>
      {errorMessage && (
        <div className="rounded-lg border border-red-500/30 bg-red-600/10 px-4 py-3 text-sm text-red-200">
          {errorMessage}
        </div>
      )}
      
      {intents.map((intent) => (
        <div
          key={intent.nullifier}
          className="bg-white/5 border border-white/10 rounded-lg p-4 hover:border-purple-500/30 transition"
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <StatusIcon status={intent.status} />
              <div>
                <p className="text-white font-medium">
                  Intent #{intent.nullifier.slice(0, 8)}...
                </p>
                <p className="text-sm text-gray-400">
                  Submitted {formatTime(intent.timestamp)}
                </p>
              </div>
            </div>
            
            <StatusBadge status={intent.status} />
          </div>

          {intent.status === 'pending' && (
            <div className="mt-3 pt-3 border-t border-white/10">
              <button
                onClick={() => handleCancel(intent.nullifier)}
                disabled={cancelling === intent.nullifier}
                className="px-3 py-2 text-xs rounded-md bg-red-600/20 text-red-300 hover:bg-red-600/30 disabled:opacity-60"
              >
                {cancelling === intent.nullifier ? 'Cancelling...' : 'Cancel Intent'}
              </button>
            </div>
          )}
          
          {intent.tokenIn && (
            <div className="mt-3 pt-3 border-t border-white/10 grid grid-cols-2 gap-4 text-sm">
              <div>
                <span className="text-gray-500">From:</span>
                <span className="text-white ml-2">{intent.amountIn} {getTokenSymbol(intent.tokenIn)}</span>
              </div>
              <div>
                <span className="text-gray-500">To:</span>
                <span className="text-white ml-2">≥{intent.expectedOut} {getTokenSymbol(intent.tokenOut!)}</span>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
};

function StatusIcon({ status }: { status: string }) {
  switch (status) {
    case 'matched':
      return <CheckCircle className="w-5 h-5 text-blue-400" />;
    case 'settled':
      return <CheckCircle className="w-5 h-5 text-green-400" />;
    case 'cancelled':
      return <XCircle className="w-5 h-5 text-red-400" />;
    case 'expired':
      return <Clock className="w-5 h-5 text-yellow-400" />;
    case 'failed':
      return <XCircle className="w-5 h-5 text-orange-400" />;
    default:
      return <Loader2 className="w-5 h-5 text-purple-400 animate-spin" />;
  }
}

function StatusBadge({ status }: { status: string }) {
  const styles = {
    pending: 'bg-purple-600/20 text-purple-400 border-purple-500/30',
    matched: 'bg-blue-600/20 text-blue-400 border-blue-500/30',
    settled: 'bg-green-600/20 text-green-400 border-green-500/30',
    cancelled: 'bg-red-600/20 text-red-400 border-red-500/30',
    expired: 'bg-yellow-600/20 text-yellow-400 border-yellow-500/30',
    failed: 'bg-orange-600/20 text-orange-400 border-orange-500/30',
  };

  return (
    <span className={`px-3 py-1 rounded-full text-xs font-medium border ${styles[status as keyof typeof styles]}`}>
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  return date.toLocaleString();
}

function getTokenSymbol(address: string): string {
  const tokens: Record<string, string> = {
    '0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7': 'ETH',
    '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d': 'STRK',
    '0x053c91253bc9682c04929ca02ed00b3e423f6710d2ee7e0d5ebb06f3ecf368a8': 'USDC',
    '0x068f5c6a61780768455de69077e07e89787839bf8166decfbf92b645209c0fb8': 'USDT',
    '0x00da114221cb83fa859dbdb4c44beeaa0bb37c7537ad5ae66fe5e0efd20e6eb3': 'DAI',
  };
  return tokens[address] || 'Token';
}
