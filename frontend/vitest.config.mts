import path from 'node:path';

import react from '@vitejs/plugin-react';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, './src') },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    // Next loads .env files itself at build time; Vitest does not. Loading them
    // here lets config.test.ts assert against the real deployment values —
    // including that the network passphrase survives its semicolon, which a
    // careless .env parser would silently truncate.
    env: loadEnv(mode, process.cwd(), 'NEXT_PUBLIC_'),
    // Contract calls and wallet prompts are deliberately out of scope here:
    // the suite covers the pure logic that decides what gets sent and how it
    // is shown. The contracts have their own 47 tests against real WASM.
    coverage: {
      include: ['src/lib/**', 'src/components/ValueBar.tsx'],
    },
  },
}));
