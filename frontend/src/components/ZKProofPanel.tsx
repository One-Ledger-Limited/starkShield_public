import React, { useMemo, useState } from 'react';
import { Lock, Unlock, FileJson, Clock, Cpu, Trash2 } from 'lucide-react';
import { useProofHistory } from '../hooks/useProofHistory';

interface ProofInfo {
  id: string;
  timestamp: number;
  provingTimeMs: number;
  nullifier: string;
  intentHash: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  minAmountOut: string;
  deadline: number;
}

export const ZKProofPanel: React.FC = () => {
  const [activeProof, setActiveProof] = useState<ProofInfo | null>(null);
  const [showTechnical, setShowTechnical] = useState(false);
  const { items, clear, stats } = useProofHistory();

  const proofs: ProofInfo[] = useMemo(() => {
    return items.map((it) => ({
      id: it.id,
      timestamp: Math.floor(it.createdAtMs / 1000),
      provingTimeMs: it.provingTimeMs,
      nullifier: it.nullifier,
      intentHash: it.intentHash,
      tokenIn: it.tokenIn,
      tokenOut: it.tokenOut,
      amountIn: it.amountIn,
      minAmountOut: it.minAmountOut,
      deadline: it.deadline,
    }));
  }, [items]);

  return (
    <div className="space-y-6">
      {/* Overview Cards */}
      <div className="grid grid-cols-3 gap-4">
        <StatCard
          icon={<Lock className="w-5 h-5" />}
          label="Proofs Generated"
          value={String(stats.count)}
          subtext="Stored locally in your browser"
        />
        <StatCard
          icon={<Clock className="w-5 h-5" />}
          label="Avg Proving Time"
          value={stats.count === 0 ? '-' : `${(stats.avgProvingTimeMs / 1000).toFixed(1)}s`}
          subtext="Measured in-browser"
        />
        <StatCard
          icon={<Cpu className="w-5 h-5" />}
          label="Circuit Size"
          value="-"
          subtext="Depends on build/circuit"
        />
      </div>

      {/* Privacy Explanation */}
      <div className="bg-gradient-to-r from-purple-600/10 to-blue-600/10 border border-purple-500/20 rounded-lg p-6">
        <div className="flex items-start space-x-4">
          <div className="w-12 h-12 bg-purple-600/20 rounded-lg flex items-center justify-center">
            <Lock className="w-6 h-6 text-purple-400" />
          </div>
          <div className="flex-1">
            <h4 className="text-lg font-medium text-white mb-2">
              Zero-Knowledge Privacy
            </h4>
            <p className="text-gray-300 mb-4">
              Your trade intents are encoded as ZK proofs that prove validity without revealing details.
              The proof demonstrates:
            </p>
            <ul className="space-y-2 text-sm text-gray-400">
              <li className="flex items-center space-x-2">
                <CheckIcon />
                <span>You own sufficient tokens for the trade</span>
              </li>
              <li className="flex items-center space-x-2">
                <CheckIcon />
                <span>You've approved the DarkPool contract</span>
              </li>
              <li className="flex items-center space-x-2">
                <CheckIcon />
                <span>The trade meets minimum output requirements</span>
              </li>
              <li className="flex items-center space-x-2">
                <CheckIcon />
                <span>The intent hasn't expired</span>
              </li>
            </ul>
          </div>
        </div>
      </div>

      {/* Proof History */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h4 className="text-lg font-medium text-white">Recent Proofs</h4>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setShowTechnical(!showTechnical)}
              className="text-sm text-purple-400 hover:text-purple-300 flex items-center space-x-1"
            >
              <FileJson className="w-4 h-4" />
              <span>{showTechnical ? 'Hide' : 'Show'} Technical Details</span>
            </button>
            <button
              onClick={() => {
                clear();
                setActiveProof(null);
              }}
              className="text-sm text-red-300 hover:text-red-200 flex items-center space-x-1"
              disabled={proofs.length === 0}
              aria-disabled={proofs.length === 0}
            >
              <Trash2 className="w-4 h-4" />
              <span>Clear</span>
            </button>
          </div>
        </div>

        {proofs.length === 0 ? (
          <div className="bg-white/5 border border-white/10 rounded-lg p-4 text-sm text-gray-300">
            No proofs yet. Go to "New Trade" and click "Generate ZK Proof".
          </div>
        ) : (
          <div className="space-y-3">
            {proofs.map((proof) => (
            <div
              key={proof.id}
              onClick={() => setActiveProof(activeProof?.id === proof.id ? null : proof)}
              className="bg-white/5 border border-white/10 rounded-lg p-4 cursor-pointer hover:border-purple-500/30 transition"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-3">
                  <div className="w-10 h-10 bg-green-600/20 rounded-lg flex items-center justify-center">
                    <Unlock className="w-5 h-5 text-green-400" />
                  </div>
                  <div>
                    <p className="text-white font-medium">Proof {proof.id}</p>
                    <p className="text-sm text-gray-400">
                      Generated {formatTimeAgo(proof.timestamp)}
                    </p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-sm text-gray-400">Proving time</p>
                  <p className="text-white font-medium">{(proof.provingTimeMs / 1000).toFixed(1)}s</p>
                </div>
              </div>

              {activeProof?.id === proof.id && showTechnical && (
                <div className="mt-4 pt-4 border-t border-white/10 space-y-3">
                  <div>
                    <span className="text-sm text-gray-500">Nullifier:</span>
                    <code className="ml-2 text-sm text-purple-400 bg-purple-600/10 px-2 py-1 rounded">
                      {proof.nullifier}
                    </code>
                  </div>
                  <div>
                    <span className="text-sm text-gray-500">Intent hash:</span>
                    <code className="ml-2 text-sm text-purple-400 bg-purple-600/10 px-2 py-1 rounded">
                      {proof.intentHash}
                    </code>
                  </div>
                  <div>
                    <span className="text-sm text-gray-500">Trade:</span>
                    <span className="ml-2 text-sm text-gray-300">
                      {proof.amountIn} {shortToken(proof.tokenIn)} → min {proof.minAmountOut} {shortToken(proof.tokenOut)}
                    </span>
                  </div>
                  <div>
                    <span className="text-sm text-gray-500">Deadline:</span>
                    <span className="ml-2 text-sm text-gray-300">{new Date(proof.deadline * 1000).toLocaleString()}</span>
                  </div>
                </div>
              )}
            </div>
            ))}
          </div>
        )}
      </div>

      {/* Security Note */}
      <div className="bg-blue-600/10 border border-blue-500/20 rounded-lg p-4">
        <div className="flex items-start space-x-3">
          <Cpu className="w-5 h-5 text-blue-400 mt-0.5" />
          <div>
            <h5 className="text-blue-300 font-medium">Client-Side Generation</h5>
            <p className="text-sm text-gray-400 mt-1">
              All ZK proofs are generated locally in your browser using WASM. Your private inputs 
              never leave your device. The proof is verified on Starknet without revealing 
              the underlying trade details.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

function StatCard({ icon, label, value, subtext }: { 
  icon: React.ReactNode; 
  label: string; 
  value: string;
  subtext: string;
}) {
  return (
    <div className="bg-white/5 border border-white/10 rounded-lg p-4">
      <div className="flex items-center space-x-2 text-purple-400 mb-2">
        {icon}
        <span className="text-sm">{label}</span>
      </div>
      <p className="text-2xl font-bold text-white">{value}</p>
      <p className="text-xs text-gray-500 mt-1">{subtext}</p>
    </div>
  );
}

function CheckIcon() {
  return (
    <svg className="w-4 h-4 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
    </svg>
  );
}

function formatTimeAgo(timestamp: number): string {
  const seconds = Math.floor(Date.now() / 1000 - timestamp);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function shortToken(addr: string): string {
  if (!addr) return '';
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}
