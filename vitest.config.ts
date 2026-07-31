import { defineConfig } from 'vitest/config';
import path from 'path';

// Virmeet — vitest config (spec P3.1). Logic-layer tests only: no jsdom, no
// browser environment. Mirrors the '@/*' -> './src/*' alias from tsconfig.json.
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'node',
  },
});
