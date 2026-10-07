import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: '/',
  build: { outDir: 'dist', target: 'es2020' },
  test: { include: ['test/**/*.test.ts'] },
});
