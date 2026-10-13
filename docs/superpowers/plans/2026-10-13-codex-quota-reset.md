---
title: Codex quota reset implementation plan
---

# Codex quota reset implementation plan

**Goal:** Anchor every Codex key's USD cycle and default usage report to Prolite.
**Architecture:** One persisted provider reference, shared by report, quota enforcement
and model budget readers; recorded reset events plus snapshots define the start.
**Tech Stack:** TypeScript, SQLite, Zod, node:test, Next.js, Docker ARM64.
**Spec:** `docs/superpowers/specs/2026-10-13-codex-quota-reset-design.md`.

## Constraints and review focus

- Sum spend across connections; do not alter inference permissions or USD caps.
- Explicit Go inspection must not select its monthly cycle for the personal budget.
- A stale cache, missing reference or inactive reference must not pick Claude or Go.
- Distinguish replenishment from a moved reset timestamp and support credit resets.
- Preserve Claude, normalized billing, family rules and fork features.

## Tasks

- [ ] Add SQLite regression tests for principal selection, every key resetting,
  cross-account USD aggregation, stale caches and subsequent reset events; run red.
- [ ] Add a typed, validated `providerQuotaResetReferences` setting and persistence
  reader. Generalize existing reset event queries to an explicit quota window.
- [ ] Resolve the reference in `apiKeyUsageLimits.ts` and `internalUsageCommand.ts`;
  infer single-provider key scope and prevent unrelated-provider reset fallback.
- [ ] Run focused quota/budget tests, core typecheck, scoped ESLint/Prettier and
  monorepo `pnpm lint:all`; obtain independent review and fix material findings.
- [ ] Commit and push to the fork; require production feature retention gate exit 0.
- [ ] Build the exact commit on ryzenwit, back up SQLite/compose/env, configure the
  Codex reference, deploy and verify unchanged command plus production key windows.
- [ ] Update deployment records and leave repositories clean; power off ryzenwit
  after its artifact leaves and verify it is offline.
