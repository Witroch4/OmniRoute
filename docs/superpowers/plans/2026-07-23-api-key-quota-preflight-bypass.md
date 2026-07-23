# API-Key Quota-Preflight Bypass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make API-key provider-quota bypass cross only persisted quota-preflight cooldowns while preserving real upstream cooldowns.

**Architecture:** Keep shared provider connection state unchanged. Credential selection derives request-scoped eligibility from `bypassQuotaPolicy` and `lastErrorSource === "quota_preflight"` before applying the normal cooldown filter.

**Tech Stack:** TypeScript, Node.js test runner, better-sqlite3, Next.js 16.

## Global Constraints

- Bypass is request-scoped and must not mutate shared connection state.
- Real upstream cooldowns, terminal states, exclusions, allowlists, model lockouts, and API-key USD limits remain enforced.
- Production must be reproducible from a commit pushed to `Witroch4/OmniRoute`.

---

### Task 1: Credential-selection regression

**Files:**
- Modify: `tests/unit/sse-auth.test.ts`
- Modify: `src/sse/services/auth.ts`

**Interfaces:**
- Consumes: `getProviderCredentials(provider, excludeConnectionId, allowedConnections, requestedModel, { bypassQuotaPolicy })`
- Produces: request-scoped eligibility for `lastErrorSource === "quota_preflight"`

- [ ] **Step 1: Write the failing tests**

Add one test that seeds a future cooldown with
`lastErrorSource: "quota_preflight"`, proves the normal request returns
`allRateLimited`, proves the bypass request returns the seeded connection, and
proves the database row remains unchanged. Add a second test that seeds the
same cooldown with `lastErrorSource: "provider_response"` and proves bypass
still returns `allRateLimited`.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
DISABLE_SQLITE_AUTO_BACKUP=true node --import tsx --import ./open-sse/utils/setupPolyfill.ts --test tests/unit/sse-auth.test.ts
```

Expected: the quota-preflight bypass assertion fails because the selector
returns `allRateLimited`.

- [ ] **Step 3: Implement the narrow eligibility predicate**

In `src/sse/services/auth.ts`, add a private predicate that returns true only
when `bypassQuotaPolicy` is true and `connection.lastErrorSource` equals
`quota_preflight`. Use it to exempt that connection from the generic
`rateLimitedUntil` rejection. Do not pass
`allowRateLimitedConnections: true`.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the auth suite plus
`tests/unit/api-key-provider-quota-bypass-scope.test.ts`. Expected: all tests
pass.

- [ ] **Step 5: Run repository validation**

Run:

```bash
npm run check:migration-numbering
npm run typecheck:core
npx eslint src/sse/services/auth.ts tests/unit/sse-auth.test.ts
npm run build
```

Expected: every command exits zero.

- [ ] **Step 6: Commit and push**

Commit the design, plan, test, and implementation with the exact validation
commands in the commit body, then push the current branch to the fork.

### Task 2: Production deployment and live verification

**Files:**
- Modify on production: `/opt/omniroute/docker-compose.yml`

**Interfaces:**
- Consumes: pushed fork commit and ARM64 image built from that exact tree
- Produces: healthy OmniRoute production deployment at `100.64.0.1:20128`

- [ ] **Step 1: Run feature-retention and disk gates**

Compare the current branch against the production family and confirm no
required fork-only feature is dropped. Record disk and Docker space before
building or transferring the image.

- [ ] **Step 2: Back up production**

Create a consistent SQLite/data backup and a timestamped copy of
`/opt/omniroute/docker-compose.yml`.

- [ ] **Step 3: Build and transfer ARM64 image**

Use the existing `omnibuild` buildx builder with `linux/arm64`,
`OMNIROUTE_USE_TURBOPACK=0`, and `OMNIROUTE_BUILD_MEMORY_MB=6144`. Tag the
image with the fix name and date, then transfer it to the Orange Pi.

- [ ] **Step 4: Deploy and verify**

Update only the OmniRoute image tag, run `docker compose up -d omniroute`,
wait for healthy status, confirm the image-to-commit mapping, and verify the
specific bypass behavior without clearing the shared connection row.
