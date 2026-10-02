import { defineConfig } from 'vitest/config';
// @ts-expect-error plain JS helper
import { alias } from './tools/example-config.mjs';

export default defineConfig({
  // Examples import `lobbyhop/*` like a real project; point those at src/.
  resolve: { alias },
  test: { include: ['tests/**/*.test.ts'] },
});
