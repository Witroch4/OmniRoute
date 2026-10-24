import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./tests/_setup/vitestUiPolyfills.ts"],
    pool: "threads",
    maxWorkers: 20,
    fileParallelism: true,
    maxConcurrency: 20,
    include: [
      "src/app/**/dashboard/cache/__tests__/**/*.test.tsx",
      "src/app/**/dashboard/endpoint/__tests__/**/*.test.tsx",
      "src/app/**/dashboard/providers/**/__tests__/**/*.test.tsx",
      "src/app/**/dashboard/webhooks/__tests__/**/*.test.tsx",
      "src/app/**/dashboard/discovery/__tests__/**/*.test.tsx",
      "src/shared/hooks/__tests__/**/*.test.tsx",
      "src/lib/memory/__tests__/**/*.test.ts",
      "src/lib/skills/__tests__/**/*.test.ts",
      "tests/unit/encryption.test.ts",
      "tests/unit/**/*.test.tsx",
      "open-sse/**/__tests__/**/*.test.ts",
      "open-sse/services/**/__tests__/**/*.test.ts",
    ],
    exclude: [
      // Standard Vitest / tooling exclusions (the "**/" forms also cover nested
      // workspace node_modules, e.g. open-sse/node_modules).
      "**/node_modules/**",
      "**/.git/**",
      "node_modules/**",
      "dist/**",
      "cypress/**",
      ".idea/**",
      ".git/**",
      ".cache/**",
      // Live-server E2E — they drive a real running OmniRoute over HTTP, so they must
      // never run in this jsdom job. They run through test:ecosystem /
      // test:protocols:e2e, which boot a server and use vitest.e2e-live.config.ts.
      "tests/e2e/ecosystem.test.ts",
      "tests/e2e/protocol-clients.test.ts",
    ],

    coverage: {
      reportsDirectory: "coverage",
    },
  },
  plugins: [react()],
  resolve: {
    alias: {
      // Optional native embeddings are outside the UI unit-test runtime.
      "@huggingface/transformers": path.resolve(
        __dirname,
        "./tests/_setup/transformersUnavailable.ts"
      ),
      "@": path.resolve(__dirname, "./src"),
      // Mirrors tsconfig paths. Without it, "@omniroute/open-sse/*" falls through to the
      // node_modules/@omniroute/open-sse symlink, which resolves against the checkout that
      // owns node_modules — in a git worktree sharing node_modules that is a DIFFERENT
      // checkout, so UI tests silently exercise someone else's open-sse code (or resolve
      // to undefined, which made every provider look credentialed in the free-tier cards).
      "@omniroute/open-sse": path.resolve(__dirname, "./open-sse"),
      "@omniroute/ui-kit": path.resolve(__dirname, "./packages/ui-kit/src"),
    },
  },
});
