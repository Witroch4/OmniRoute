import test from "node:test";
import { mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Fix B — a stale exhausted quota-cache entry must not block a recovered account.
 *
 * A Codex "session"/plan window can report a far-future reset (~30 days). When
 * that window hits 0%, the in-memory cache stores exhausted=true with that
 * far-future `nextResetAt`. The TTL escape in `isAccountQuotaExhausted` only
 * fires when `nextResetAt` is absent, so before this fix the account stayed
 * blocked until the far reset even after it recovered — forcing traffic onto an
 * exhausted lower-priority account (observed: a priority-1 Codex key blocked for
 * ~27 days while its session was back at 100%). Once the entry is older than the
 * refresh window, the getter now re-reads the latest persisted snapshot.
 */
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omni-quota-stale-exhausted-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const coreDb = await import("../../src/lib/db/core.ts");
const quotaSnapshotsDb = await import("../../src/lib/db/quotaSnapshots.ts");
const quotaCache = await import("../../src/domain/quotaCache.ts");

const T0 = Date.UTC(2026, 6, 22, 20, 0, 0); // 2026-07-22T20:00:00Z
const FAR_RESET = new Date(Date.UTC(2026, 7, 19, 11, 46, 34)).toISOString(); // ~28 days out

test.after(() => {
  mock.timers.reset();
  coreDb.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("#B stale exhausted entry with far reset re-validates against a fresh healthy snapshot", () => {
  mock.timers.reset();
  mock.timers.enable({ apis: ["Date"] });
  mock.timers.setTime(T0);

  const connectionId = "conn-stale-exhausted-B";

  // Prime an exhausted in-memory entry: session at 0% with a far-future reset.
  quotaCache.setQuotaCache(connectionId, "codex", {
    session: { remainingPercentage: 0, resetAt: FAR_RESET },
  });

  // Immediately (fresh entry, age ~0) it must still read as exhausted — the fix
  // must NOT unblock a genuinely fresh exhausted entry.
  assert.equal(
    quotaCache.isAccountQuotaExhausted(connectionId),
    true,
    "fresh exhausted entry must stay blocked"
  );

  // The account recovers: a newer snapshot shows the session window back at 100%.
  mock.timers.tick(6 * 60 * 1000); // advance past EXHAUSTED_REFRESH_MS (5 min)
  quotaSnapshotsDb.saveQuotaSnapshot({
    provider: "codex",
    connection_id: connectionId,
    window_key: "session",
    remaining_percentage: 100,
    is_exhausted: 0,
    next_reset_at: FAR_RESET,
    window_duration_ms: null,
    raw_data: null,
  });

  // Now the entry is stale (>5 min) AND the persisted truth is healthy → unblock.
  assert.equal(
    quotaCache.isAccountQuotaExhausted(connectionId),
    false,
    "stale exhausted entry must re-validate to healthy from the latest snapshot"
  );
});

test("#B stale entry whose latest snapshot is still exhausted stays blocked", () => {
  mock.timers.reset();
  mock.timers.enable({ apis: ["Date"] });
  mock.timers.setTime(T0);

  const connectionId = "conn-stale-still-exhausted-B";
  quotaCache.setQuotaCache(connectionId, "codex", {
    session: { remainingPercentage: 0, resetAt: FAR_RESET },
  });

  mock.timers.tick(6 * 60 * 1000);
  quotaSnapshotsDb.saveQuotaSnapshot({
    provider: "codex",
    connection_id: connectionId,
    window_key: "session",
    remaining_percentage: 0,
    is_exhausted: 1,
    next_reset_at: FAR_RESET,
    window_duration_ms: null,
    raw_data: null,
  });

  assert.equal(
    quotaCache.isAccountQuotaExhausted(connectionId),
    true,
    "genuinely-still-exhausted account must remain blocked after re-validation"
  );
});
