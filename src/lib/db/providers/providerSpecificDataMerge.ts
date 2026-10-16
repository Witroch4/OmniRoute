import { getDbInstance } from "../core";
import { encryptConnectionFields } from "../encryption";
import { invalidateDbCache } from "../readCache";
import { parseProviderSpecificData } from "../webSessionDedup";

interface StatementLike<TRow = unknown> {
  get: (...params: unknown[]) => TRow | undefined;
  run: (...params: unknown[]) => { changes?: number };
}

interface DbLike {
  prepare: <TRow = unknown>(sql: string) => StatementLike<TRow>;
  transaction: <T>(fn: () => T) => () => T;
}

/**
 * Merge a patch into a connection's `provider_specific_data` in one transaction,
 * without the full-row rewrite (and DB backup) of `updateProviderConnection()`.
 * ONLY for non-structural account-state patches on registry providers; a
 * compatible node's providerSpecificData can carry model lists and must go
 * through `updateProviderConnection()`.
 *
 * Ported from upstream (#16532). Upstream invalidates with
 * `{ skipModelCatalog: true }` (#13389); the fork's read cache has no such
 * option yet, so the whole connections scope is invalidated.
 */
export async function mergeConnectionProviderSpecificData(
  id: string,
  patch: Record<string, unknown>
): Promise<void> {
  const db = getDbInstance() as unknown as DbLike;
  // Transaction so a concurrent merge cannot lose a key: the SELECT and
  // UPDATE must observe the same row version (codex account-state precedent).
  db.transaction(() => {
    const row = db
      .prepare("SELECT provider_specific_data FROM provider_connections WHERE id = ?")
      .get(id);
    if (!row) return;

    const existing =
      parseProviderSpecificData(
        (row as { provider_specific_data?: unknown }).provider_specific_data
      ) ?? {};
    const merged = { ...existing, ...patch };
    // A patch carrying a declared secret field in plaintext (a quota fetcher refreshing
    // a console cookie, an executor minting a bearer) is enveloped exactly like a
    // full-row write; values already stored as envelopes are left as they are.
    const stored = encryptConnectionFields({ providerSpecificData: merged }).providerSpecificData;
    db.prepare(
      "UPDATE provider_connections SET provider_specific_data = ?, updated_at = ? WHERE id = ?"
    ).run(JSON.stringify(stored), new Date().toISOString(), id);
    invalidateDbCache("connections");
  })();
}
