import { defineConfig } from 'vitest/config';
// Tests share one Postgres database (schema is reset per file), so files run sequentially.
export default defineConfig({ test: { fileParallelism: false } });
