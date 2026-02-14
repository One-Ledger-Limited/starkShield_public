import React from 'react';
import { InjectedConnector, StarknetConfig, publicProvider } from '@starknet-react/core';
import { constants } from 'starknet';

const connectors = [
  new InjectedConnector({
    options: {
      id: 'argentX',
      name: 'Argent X',
    },
  }),
  new InjectedConnector({
    options: {
      id: 'braavos',
      name: 'Braavos',
    },
  }),
];

interface StarknetProviderProps {
  children: React.ReactNode;
}

const rawChainId = import.meta.env.VITE_CHAIN_ID ?? 'SN_SEPOLIA';
const chainId =
  rawChainId === 'SN_MAIN'
    ? constants.StarknetChainId.SN_MAIN
    : constants.StarknetChainId.SN_SEPOLIA;

const chains = [
  {
    id: chainId,
    name: rawChainId === 'SN_MAIN' ? 'Starknet Mainnet' : 'Starknet Sepolia',
    network: rawChainId === 'SN_MAIN' ? 'mainnet' : 'sepolia',
    testnet: rawChainId !== 'SN_MAIN',
    nativeCurrency: {
      address: '0x0',
      name: 'Ether',
      symbol: 'ETH',
      decimals: 18,
    },
    rpcUrls: {
      default: {
        http: [import.meta.env.VITE_RPC_URL ?? '/v1/starknet-rpc'],
      },
      public: {
        http: [import.meta.env.VITE_RPC_URL ?? '/v1/starknet-rpc'],
      },
    },
  } as any,
];

export const StarknetProvider: React.FC<StarknetProviderProps> = ({ children }) => {
  return (
    <StarknetConfig
      chains={chains}
      connectors={connectors}
      provider={publicProvider()}
      autoConnect
    >
      {children}
    </StarknetConfig>
  );
};
