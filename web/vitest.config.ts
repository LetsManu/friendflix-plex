import { defineConfig } from 'vitest/config';

// Unit tests cover pure modules only (no SvelteKit plugin; tsconfig extends a generated file, so it is not read here).
export default defineConfig({ oxc: { tsconfig: false } as any, test: { include: ['src/**/*.test.ts'] } });
