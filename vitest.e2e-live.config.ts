import { defineConfig } from "vitest/config";
import path from "path";

/**
 * Live-server E2E suites (`tests/e2e/ecosystem.test.ts`,
 * `tests/e2e/protocol-clients.test.ts`).
 *
 * These are the only two Vitest suites that drive a REAL running OmniRoute over HTTP
 * rather than importing modules. Their runners — `scripts/dev/run-ecosystem-tests.mjs`
 * (`npm run test:ecosystem`) and `scripts/dev/run-protocol-clients-tests.mjs`
 * (`npm run test:protocols:e2e`) — boot a dev server, wait for
 * `/api/monitoring/health`, then invoke Vitest with this config.
 *
 * They need their own config because `vitest.config.ts` (the jsdom UI suite) must not
 * collect them: without a server every case fails with `fetch failed` /
 * `ECONNREFUSED 127.0.0.1:20128`. Same split upstream uses.
 */
export default defineConfig({
  test: {
    // Real HTTP against a running server — never jsdom.
    environment: "node",
    globals: true,
    include: ["tests/e2e/ecosystem.test.ts", "tests/e2e/protocol-clients.test.ts"],
    exclude: ["**/node_modules/**", "**/.git/**"],
    // Both suites share ONE server instance, so files must not run concurrently.
    fileParallelism: false,
    // Calls over the network are slower than in-process unit tests; the suites
    // themselves also read ECOSYSTEM_*_TIMEOUT_MS for their per-case budgets.
    testTimeout: 60000,
    hookTimeout: 60000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // Mirrors tsconfig paths, same as vitest.config.ts.
      "@omniroute/open-sse": path.resolve(__dirname, "./open-sse"),
    },
  },
});
