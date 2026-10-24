import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
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
      "tests/e2e/ecosystem.test.ts",
      "tests/e2e/protocol-clients.test.ts",
    ],
    exclude: [
      "**/node_modules/**",
      "**/.git/**",
      "open-sse/services/autoCombo/__tests__/providerDiversity.test.ts",
    ],
    coverage: {
      reportsDirectory: "coverage",
    },
  },
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // Mirrors tsconfig paths. Without it, "@omniroute/open-sse/*" falls through to the
      // node_modules/@omniroute/open-sse symlink, which resolves against the checkout that
      // owns node_modules — in a git worktree sharing node_modules that is a DIFFERENT
      // checkout, so UI tests silently exercise someone else's open-sse code.
      "@omniroute/open-sse": path.resolve(__dirname, "./open-sse"),
    },
  },
});
