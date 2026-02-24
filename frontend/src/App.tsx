import React, { useEffect, useMemo, useState } from 'react';
import { useAccount, useConnect, useDisconnect } from '@starknet-react/core';
import { Shield, Wallet, ArrowRightLeft, Lock, Zap, Eye } from 'lucide-react';
import { TradeForm } from './components/TradeForm';
import { IntentStatus } from './components/IntentStatus';
import { ZKProofPanel } from './components/ZKProofPanel';
import { apiClient } from '../lib/api-client';
import { toUserErrorMessage } from './constants/error-messages';
import { useFlowProgress } from './hooks/useFlowProgress';

interface LoginResponse {
  success: boolean;
  token: string;
  expires_in_seconds: number;
}

const REQUIRE_LOGIN = (import.meta.env.VITE_REQUIRE_LOGIN as string | undefined)?.toLowerCase() === 'true';

function formatWalletAddress(address?: string): string {
  if (!address) return '';
  const trimmed = address.trim().toLowerCase();
  if (!trimmed.startsWith('0x')) return trimmed;
  const hex = trimmed.slice(2).replace(/^0+/, '') || '0';
  const normalized = `0x${hex.padStart(64, '0')}`;
  return `${normalized.slice(0, 6)}...${normalized.slice(-4)}`;
}

function App() {
  const { address, isConnected } = useAccount();
  const { connect, connectors } = useConnect();
  const { disconnect } = useDisconnect();
  const [activeTab, setActiveTab] = useState<'trade' | 'status' | 'proofs'>('trade');
  const [token, setToken] = useState<string | null>(() => localStorage.getItem('token'));
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [loggingIn, setLoggingIn] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [availableWallets, setAvailableWallets] = useState<{ argentX: boolean; braavos: boolean }>({
    argentX: false,
    braavos: false,
  });
  const { progress } = useFlowProgress();

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    const walletWindow = window as unknown as {
      starknet?: { id?: string };
      starknet_argentX?: unknown;
      starknet_braavos?: unknown;
    };
    setAvailableWallets({
      argentX: Boolean(walletWindow.starknet_argentX) || walletWindow.starknet?.id === 'argentX',
      braavos: Boolean(walletWindow.starknet_braavos) || walletWindow.starknet?.id === 'braavos',
    });
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handler = () => setToken(localStorage.getItem('token'));
    window.addEventListener('starkshield:auth:invalid', handler);
    return () => window.removeEventListener('starkshield:auth:invalid', handler);
  }, []);

  const walletHint = useMemo(() => {
    if (availableWallets.argentX || availableWallets.braavos) {
      return null;
    }
    return 'No Starknet wallet extension detected. Please install/unlock Argent X or Braavos. If using an intranet IP URL, wallet injection may be blocked on some browsers.';
  }, [availableWallets]);

  const handleLogin = async () => {
    setLoggingIn(true);
    setAuthError(null);
    try {
      const { data } = await apiClient.post<LoginResponse>('/v1/auth/login', {
        username,
        password,
      });
      localStorage.setItem('token', data.token);
      setToken(data.token);
      setPassword('');
    } catch (error) {
      setAuthError(toUserErrorMessage(error));
    } finally {
      setLoggingIn(false);
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('token');
    setToken(null);
    disconnect();
  };

  const handleConnectWallet = async (connector: (typeof connectors)[number]) => {
    setWalletError(null);
    try {
      await Promise.resolve(connect({ connector }));
    } catch (error) {
      setWalletError(toUserErrorMessage(error));
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900">
      {/* Header */}
      <header className="border-b border-white/10 backdrop-blur-lg">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            <div className="flex items-center space-x-3">
              <Shield className="w-8 h-8 text-purple-400" />
              <span className="text-2xl font-bold text-white">StarkShield</span>
            </div>
            
            <div className="flex items-center space-x-4">
              <div className="flex flex-wrap items-center justify-end gap-2">
                {isConnected ? (
                  <span className="text-sm text-gray-400">
                    {formatWalletAddress(address)}
                  </span>
                ) : (
                  connectors.map((connector) => (
                    <button
                      key={connector.id}
                      onClick={() => handleConnectWallet(connector)}
                      className="btn-primary flex items-center space-x-2 px-4 py-2"
                    >
                      <Wallet className="w-4 h-4" />
                      <span>Connect {connector.name}</span>
                    </button>
                  ))
                )}

                {REQUIRE_LOGIN && token && (
                  <button onClick={handleLogout} className="btn-secondary px-4 py-2">
                    Logout
                  </button>
                )}

                {walletHint && <p className="w-full text-xs text-yellow-300">{walletHint}</p>}
                {walletError && <p className="w-full text-xs text-red-300">{walletError}</p>}
              </div>
            </div>
          </div>
        </div>
      </header>

      {/* Hero Section */}
      <div className="relative overflow-hidden">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
          <div className="text-center">
            <h1 className="text-5xl font-bold text-white mb-4">
              MEV-Free Trading on{' '}
              <span className="text-transparent bg-clip-text bg-gradient-to-r from-purple-400 to-pink-400">
                Starknet
              </span>
            </h1>
            <p className="text-xl text-gray-300 max-w-2xl mx-auto">
              Trade with zero-knowledge privacy. Your orders are protected from sandwich attacks 
              and front-running through client-side proof generation.
            </p>
          </div>

          {/* Feature Cards */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mt-12">
            <FeatureCard
              icon={<Lock className="w-6 h-6" />}
              title="Privacy Protected"
              description="Orders never hit the public mempool. Trade sizes and directions remain hidden."
            />
            <FeatureCard
              icon={<Zap className="w-6 h-6" />}
              title="Zero MEV"
              description="No sandwich attacks, no front-running. Your trades execute at fair prices."
            />
            <FeatureCard
              icon={<Eye className="w-6 h-6" />}
              title="Client-Side ZK"
              description="Proofs generated locally in your browser. No trusted third parties."
            />
          </div>
        </div>
      </div>

      {REQUIRE_LOGIN && !token && (
        <div className="max-w-md mx-auto px-4 pb-8">
          <div className="glass-card p-6 space-y-4">
            <h3 className="text-white text-xl font-semibold">Login</h3>
            {authError && <p className="text-sm text-red-300">{authError}</p>}
            <input
              aria-label="Username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full rounded-lg border border-white/20 bg-white/5 px-3 py-2 text-white"
              placeholder="Username"
            />
            <input
              aria-label="Password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-lg border border-white/20 bg-white/5 px-3 py-2 text-white"
              placeholder="Password"
            />
            <button
              onClick={handleLogin}
              disabled={loggingIn || !username || !password}
              className="btn-cta w-full py-2 disabled:opacity-60"
            >
              {loggingIn ? 'Logging in...' : 'Login'}
            </button>
            <div className="rounded-lg border border-yellow-500/30 bg-yellow-600/10 p-3 text-xs text-yellow-300">
              <p>
                Credentials are configured on the solver via environment variables (e.g. <code>AUTH_USERNAME</code>,
                <code>AUTH_PASSWORD</code>, <code>JWT_SECRET</code>).
              </p>
              <p>For public repos, we do not ship demo passwords in the frontend.</p>
            </div>
          </div>
        </div>
      )}

      {/* Main Content (UI is public; operations require login) */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pb-12">
        <div className="glass-card overflow-hidden">
          {REQUIRE_LOGIN && (!token || !isConnected) && (
            <div className="border-b border-white/10 bg-white/5 px-6 py-4 text-sm text-gray-300">
              <span className="text-white font-medium">Read-only mode:</span>{' '}
              Login and connect your wallet to submit intents and manage status.
            </div>
          )}

          {/* Tabs */}
          <div className="flex border-b border-white/10">
            <TabButton
              active={activeTab === 'trade'}
              onClick={() => setActiveTab('trade')}
              icon={<ArrowRightLeft className="w-4 h-4" />}
              label="New Trade"
            />
            <TabButton
              active={activeTab === 'status'}
              onClick={() => setActiveTab('status')}
              icon={<Shield className="w-4 h-4" />}
              label="Intent Status"
            />
            <TabButton
              active={activeTab === 'proofs'}
              onClick={() => setActiveTab('proofs')}
              icon={<Lock className="w-4 h-4" />}
              label="ZK Proofs"
            />
          </div>

          {/* Tab Content */}
          <div className="p-6">
            {activeTab === 'trade' && <TradeForm />}
            {activeTab === 'status' && <IntentStatus />}
            {activeTab === 'proofs' && <ZKProofPanel />}
          </div>
        </div>
      </div>

      {/* How It Works (public) */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <h2 className="text-3xl font-bold text-white text-center mb-8">How It Works</h2>
        <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
          {(() => {
            type StepStatus = 'done' | 'active' | 'todo';
            const hasProof = Boolean(progress.lastProofAtMs);
            const hasSubmitted = Boolean(progress.lastIntentSubmittedAtMs);
            const currentIndex = !isConnected
              ? 0
              : !token
                ? 1
                : !hasProof
                  ? 2
                  : !hasSubmitted
                    ? 3
                    : 4;
            const statusFor = (idx: number): StepStatus => {
              if (idx < currentIndex) return 'done';
              if (idx === currentIndex) return 'active';
              return 'todo';
            };
            return (
              <>
                <StepCard
                  number="1"
                  title="Connect Wallet"
                  description="Connect Argent X or Braavos"
                  status={statusFor(0)}
                />
                <StepCard
                  number="2"
                  title="Login"
                  description="Authenticate to use solver APIs"
                  status={statusFor(1)}
                />
                <StepCard
                  number="3"
                  title="Create Intent"
                  description="Define trade parameters in the browser"
                  status={statusFor(2)}
                />
                <StepCard
                  number="4"
                  title="Generate Proof"
                  description="ZK proof created locally, never leaves your device"
                  status={statusFor(3)}
                />
                <StepCard
                  number="5"
                  title="Submit & Match"
                  description="Encrypted intent is matched and settled"
                  status={statusFor(4)}
                />
              </>
            );
          })()}
        </div>
      </div>
    </div>
  );
}

function FeatureCard({ icon, title, description }: { icon: React.ReactNode; title: string; description: string }) {
  return (
    <div className="bg-white/5 backdrop-blur-lg rounded-xl p-6 border border-white/10 hover:border-purple-500/50 transition">
      <div className="w-12 h-12 bg-purple-600/20 rounded-lg flex items-center justify-center text-purple-400 mb-4">
        {icon}
      </div>
      <h3 className="text-lg font-semibold text-white mb-2">{title}</h3>
      <p className="text-gray-400 text-sm">{description}</p>
    </div>
  );
}

function TabButton({ active, onClick, icon, label }: { 
  active: boolean; 
  onClick: () => void; 
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center space-x-2 px-6 py-4 text-sm font-medium transition border-b-2 ${
        active
          ? 'border-purple-500 text-purple-400'
          : 'border-transparent text-gray-400 hover:text-white'
      }`}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function StepCard({
  number,
  title,
  description,
  status,
}: {
  number: string;
  title: string;
  description: string;
  status: 'done' | 'active' | 'todo';
}) {
  const dotClass =
    status === 'done'
      ? 'bg-green-600 text-white'
      : status === 'active'
        ? 'bg-purple-600 text-white ring-2 ring-purple-400/60 animate-pulse'
        : 'bg-white/10 text-gray-300';
  const lineClass =
    status === 'done'
      ? 'bg-gradient-to-r from-green-500/70 to-transparent'
      : status === 'active'
        ? 'bg-gradient-to-r from-purple-600 to-transparent'
        : 'bg-gradient-to-r from-white/15 to-transparent';

  return (
    <div className="relative">
      <div className={`w-10 h-10 rounded-full flex items-center justify-center font-bold mb-3 ${dotClass}`}>
        {number}
      </div>
      <h4 className="text-white font-medium mb-1">{title}</h4>
      <p className="text-gray-400 text-sm">{description}</p>
      {number !== '5' && (
        <div className={`hidden md:block absolute top-5 left-full w-full h-0.5 ${lineClass}`} />
      )}
    </div>
  );
}

export default App;
