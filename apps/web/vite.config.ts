import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Resolve workspace packages to their TypeScript sources (see packages/sdk "exports").
  resolve: { conditions: ['xpool-source', 'browser', 'module', 'import', 'default'] },
  worker: { format: 'es' },
  server: { port: 5173, strictPort: true, fs: { allow: ['../..'] } },
  build: { target: 'es2022', sourcemap: true },
});
