import React from 'react';
import ReactDOM from 'react-dom/client';
import { StarknetProvider } from './providers/StarknetProvider';
import { QueryClient, QueryClientProvider } from 'react-query';
import { Buffer } from 'buffer';
import App from './App';
import './index.css';

if (!(globalThis as { Buffer?: typeof Buffer }).Buffer) {
  (globalThis as { Buffer?: typeof Buffer }).Buffer = Buffer;
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5, // 5 minutes
      retry: 3,
    },
  },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <StarknetProvider>
        <App />
      </StarknetProvider>
    </QueryClientProvider>
  </React.StrictMode>
);
