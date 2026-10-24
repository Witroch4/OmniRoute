---
title: Codex quota reset implementation plan
---

# Codex quota reset implementation plan

**Goal:** Anchor every Codex key's USD cycle and default usage report to Prolite.
**Architecture:** One persisted provider reference, shared by report, quota enforcement
and model budget readers; recorded reset events plus snapshots define the start.
**Tech Stack:** TypeScript, SQLite, Zod, node:test, Next.js, Docker ARM64.
**Spec:** `docs/fork/specs/2026-10-13-codex-quota-reset-design.md`.

## Constraints and review focus

- Sum spend across connections; do not alter inference permissions or USD caps.
- Explicit Go inspection must not select its monthly cycle for the personal budget.
- A stale cache, missing reference or inactive reference must not pick Claude or Go.
- Distinguish replenishment from a moved reset timestamp and support credit resets.
- Preserve Claude, normalized billing, family rules and fork features.

## Tasks

- [x] Add SQLite regression tests for principal selection, every key resetting,
      cross-account USD aggregation, stale caches and subsequent reset events; run red.
- [x] Add a typed, validated `providerQuotaResetReferences` setting and persistence
      reader. Generalize existing reset event queries to an explicit quota window.
- [x] Resolve the reference in `apiKeyUsageLimits.ts` and `internalUsageCommand.ts`;
      infer single-provider key scope and prevent unrelated-provider reset fallback.
- [x] Run focused quota/budget tests, core typecheck, scoped ESLint/Prettier and
      monorepo `pnpm lint:all`; obtain independent review and fix material findings.
- [x] Commit and push to the fork; require production feature retention gate exit 0.
- [x] Build the exact commit on ryzenwit, back up SQLite/compose/env, configure the
      Codex reference, deploy and verify unchanged command plus production key windows.
- [x] Update deployment records and leave repositories clean; power off ryzenwit
      after its artifact leaves and verify it is offline.

## Deployment evidence

Deployed source: `83585d659a039080cdab5c4a2b5bc635a9fe7002`, image
`omniroute:codex-principal-reset-20261013`, ARM64 image ID
`sha256:c3154739bfc4254e3d97ae333c9ec10784b94674805b283afb4ea76b2292eb54`.
151 focused tests, core typecheck, scoped ESLint/Prettier, Fumadocs and the
production retention gate passed. Build exited 0 and generated 634 pages.

Production health HTTP 200 / Docker healthy. The original command through tailnet
returned HTTP 200 for active Jean, 87% personal remaining. All four configured
Codex USD quotas use the observed start `2026-10-13T05:01:45.673Z` and next reset
`2026-10-20T11:53:07.000Z`; inactive keys retain their prior activation state.
Real successful Codex traffic after deployment and M365 protection were verified.

Backup: `/opt/omniroute/backups/20261013-codex-principal-before-deploy`.
Rollback: `omniroute:m365-cooldown-20261012` (old Codex quota behavior).
Disk 67%, 37 GB available. ryzenwit powered off; tailnet ping timed out.
Monorepo `pnpm lint:all` reports two pre-existing formatting failures outside OM;
production retains the previously documented three migration renumber warnings.
