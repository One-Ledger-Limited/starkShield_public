import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  optimizeDeps: {
    include: ['snarkjs'],
  },
  build: {
    target: 'esnext',
    rollupOptions: {
      output: {
        manualChunks: {
          'starknet-deps': ['starknet', '@starknet-react/core'],
          'zk-deps': ['snarkjs'],
        },
      },
    },
  },
  server: {
    port: 5173,
    open: true,
  },
});
