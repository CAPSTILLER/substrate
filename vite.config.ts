import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  base: '/',
  build: {
    outDir: 'dist',
    target: 'es2020',
    rollupOptions: { input: { main: resolve(__dirname, 'index.html'), room: resolve(__dirname, 'room.html') } },
  },
  test: { include: ['test/**/*.test.ts'] },
});
