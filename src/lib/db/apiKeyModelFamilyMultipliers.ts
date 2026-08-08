/**
 * Per-API-key, per-model-family USD multipliers (see migration 128).
 *
 * A rule says: on `provider`, when a request's BILLED family matches the
 * `familyGlob`, scale its normalized cost by `multiplier`. Independent of
 * `apiKeyModelBudgetRules.ts` — a family can carry a multiplier with no
 * redirect rule at all.
 *
 * Every reader of this table must resolve rules through
 * `src/lib/usage/modelFamilyMultiplier.ts`'s `resolveFamilyMultiplier` — this
 * module only stores/validates rows, it never decides what a stored value
 * means at cost-computation time (that neutral-fallback contract lives in the
 * shared resolver, not here).
 */

import { randomUUID } from "node:crypto";

import { getDbInstance } from "./core";

/**
 * Write-time ceiling: a multiplier above this can never be saved, regardless
 * of caller. Guards against the classic fat-finger — `150` typed instead of
 * `1.50` — which would otherwise silently burn a client's entire quota on a
 * single request. 20x has no legitimate use case for a per-family spend
 * penalty (even the widest Claude tier spread is nowhere near that); anything
 * above it is treated as operator error, not intent.
 */
export const MAX_FAMILY_MULTIPLIER = 20;

export interface FamilyMultiplierRule {
  id: string;
  apiKeyId: string;
  enabled: boolean;
  priority: number;
  provider: string;
  familyGlob: string;
  multiplier: number;
}

export type FamilyMultiplierRuleInput = Omit<FamilyMultiplierRule, "id" | "apiKeyId">;

type Row = {
  id: string;
  api_key_id: string;
  enabled: number;
  priority: number;
  provider: string;
  family_glob: string;
  multiplier: number;
};

function toRule(row: Row): FamilyMultiplierRule {
  return {
    id: row.id,
    apiKeyId: row.api_key_id,
    enabled: row.enabled === 1,
    priority: Number(row.priority) || 0,
    provider: row.provider,
    familyGlob: row.family_glob,
    multiplier: Number(row.multiplier),
  };
}

function requireField(value: unknown, field: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`Model family multiplier: ${field} is required`);
  return text;
}

/**
 * Write-time validation only — accepts a plain dot-decimal number (comma
 * normalization to a dot is a UI-input concern, done before this is called;
 * see `normalizeDecimalInput` in the API-manager payload module). Rejects
 * non-positive and out-of-range values outright rather than silently
 * clamping, so a save attempt with `0` or `150` fails loudly instead of
 * persisting a value that reads back as something the operator never typed.
 */
function requireValidMultiplier(value: unknown): number {
  const multiplier = Number(value);
  if (!Number.isFinite(multiplier) || multiplier <= 0) {
    throw new Error("Model family multiplier: multiplier must be a positive number");
  }
  if (multiplier > MAX_FAMILY_MULTIPLIER) {
    throw new Error(`Model family multiplier: multiplier must be ${MAX_FAMILY_MULTIPLIER} or less`);
  }
  return multiplier;
}

export function listFamilyMultipliers(apiKeyId: string): FamilyMultiplierRule[] {
  if (!apiKeyId) return [];
  return (
    getDbInstance()
      .prepare(
        `SELECT * FROM api_key_model_family_multipliers
          WHERE api_key_id = ? AND enabled = 1
          ORDER BY priority ASC, id ASC`
      )
      .all(apiKeyId) as Row[]
  ).map(toRule);
}

export function listAllFamilyMultipliers(apiKeyId: string): FamilyMultiplierRule[] {
  if (!apiKeyId) return [];
  return (
    getDbInstance()
      .prepare(
        `SELECT * FROM api_key_model_family_multipliers
          WHERE api_key_id = ?
          ORDER BY priority ASC, id ASC`
      )
      .all(apiKeyId) as Row[]
  ).map(toRule);
}

export function deleteFamilyMultipliersForApiKey(apiKeyId: string): void {
  if (!apiKeyId) return;
  getDbInstance()
    .prepare("DELETE FROM api_key_model_family_multipliers WHERE api_key_id = ?")
    .run(apiKeyId);
}

/**
 * Full-swap replace: validates every row before opening the transaction (so a
 * bad row never leaves a half-applied set on disk), then deletes + re-inserts
 * atomically — mirrors `replaceModelBudgetRules`.
 */
export function replaceFamilyMultipliers(
  apiKeyId: string,
  rules: FamilyMultiplierRuleInput[]
): FamilyMultiplierRule[] {
  if (!apiKeyId) throw new Error("Model family multiplier: apiKeyId is required");

  const now = new Date().toISOString();
  const prepared = rules.map((rule) => {
    const multiplier = requireValidMultiplier(rule.multiplier);
    return {
      id: randomUUID(),
      apiKeyId,
      enabled: rule.enabled !== false,
      priority: Number.isFinite(Number(rule.priority)) ? Number(rule.priority) : 0,
      provider: requireField(rule.provider, "provider"),
      familyGlob: requireField(rule.familyGlob, "familyGlob"),
      multiplier,
    } satisfies FamilyMultiplierRule;
  });

  const db = getDbInstance();
  const insert = db.prepare(
    `INSERT INTO api_key_model_family_multipliers
       (id, api_key_id, enabled, priority, provider, family_glob, multiplier, created_at, updated_at)
     VALUES (@id, @apiKeyId, @enabled, @priority, @provider, @familyGlob, @multiplier, @now, @now)`
  );

  db.transaction(() => {
    db.prepare("DELETE FROM api_key_model_family_multipliers WHERE api_key_id = ?").run(apiKeyId);
    for (const rule of prepared) {
      insert.run({ ...rule, enabled: rule.enabled ? 1 : 0, now });
    }
  })();

  return prepared;
}
