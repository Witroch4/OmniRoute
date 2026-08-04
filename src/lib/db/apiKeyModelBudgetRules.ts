/**
 * Per-API-key model budget routing rules (see migration 125).
 *
 * A rule says: on `sourceProvider`, once this key's REAL weekly spend on the
 * `sourceFamily` glob reaches `weeklyLimitUsd`, serve matching requests from
 * `targetProvider` + `targetFamily` instead, silently.
 */

import { randomUUID } from "node:crypto";

import { getDbInstance } from "./core";

export interface ModelBudgetRule {
  id: string;
  apiKeyId: string;
  enabled: boolean;
  priority: number;
  sourceProvider: string;
  sourceFamily: string;
  weeklyLimitUsd: number;
  targetProvider: string;
  targetFamily: string;
}

export type ModelBudgetRuleInput = Omit<ModelBudgetRule, "id" | "apiKeyId">;

type Row = {
  id: string;
  api_key_id: string;
  enabled: number;
  priority: number;
  source_provider: string;
  source_family: string;
  weekly_limit_usd: number;
  target_provider: string;
  target_family: string;
};

function toRule(row: Row): ModelBudgetRule {
  return {
    id: row.id,
    apiKeyId: row.api_key_id,
    enabled: row.enabled === 1,
    priority: Number(row.priority) || 0,
    sourceProvider: row.source_provider,
    sourceFamily: row.source_family,
    weeklyLimitUsd: Number(row.weekly_limit_usd),
    targetProvider: row.target_provider,
    targetFamily: row.target_family,
  };
}

function requireField(value: unknown, field: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`Model budget rule: ${field} is required`);
  return text;
}

export function listModelBudgetRules(apiKeyId: string): ModelBudgetRule[] {
  if (!apiKeyId) return [];
  return (
    getDbInstance()
      .prepare(
        `SELECT * FROM api_key_model_budget_rules
          WHERE api_key_id = ? AND enabled = 1
          ORDER BY priority ASC, id ASC`
      )
      .all(apiKeyId) as Row[]
  ).map(toRule);
}

export function listAllModelBudgetRules(apiKeyId: string): ModelBudgetRule[] {
  if (!apiKeyId) return [];
  return (
    getDbInstance()
      .prepare(
        `SELECT * FROM api_key_model_budget_rules
          WHERE api_key_id = ?
          ORDER BY priority ASC, id ASC`
      )
      .all(apiKeyId) as Row[]
  ).map(toRule);
}

export function deleteModelBudgetRulesForApiKey(apiKeyId: string): void {
  if (!apiKeyId) return;
  getDbInstance()
    .prepare("DELETE FROM api_key_model_budget_rules WHERE api_key_id = ?")
    .run(apiKeyId);
}

export function replaceModelBudgetRules(
  apiKeyId: string,
  rules: ModelBudgetRuleInput[]
): ModelBudgetRule[] {
  if (!apiKeyId) throw new Error("Model budget rule: apiKeyId is required");

  const now = new Date().toISOString();
  const prepared = rules.map((rule) => {
    const weeklyLimitUsd = Number(rule.weeklyLimitUsd);
    if (!Number.isFinite(weeklyLimitUsd) || weeklyLimitUsd <= 0) {
      throw new Error("Model budget rule: weeklyLimitUsd must be a positive number");
    }
    return {
      id: randomUUID(),
      apiKeyId,
      enabled: rule.enabled !== false,
      priority: Number.isFinite(Number(rule.priority)) ? Number(rule.priority) : 0,
      sourceProvider: requireField(rule.sourceProvider, "sourceProvider"),
      sourceFamily: requireField(rule.sourceFamily, "sourceFamily"),
      weeklyLimitUsd,
      targetProvider: requireField(rule.targetProvider, "targetProvider"),
      targetFamily: requireField(rule.targetFamily, "targetFamily"),
    } satisfies ModelBudgetRule;
  });

  const db = getDbInstance();
  const insert = db.prepare(
    `INSERT INTO api_key_model_budget_rules
       (id, api_key_id, enabled, priority, source_provider, source_family,
        weekly_limit_usd, target_provider, target_family, created_at, updated_at)
     VALUES (@id, @apiKeyId, @enabled, @priority, @sourceProvider, @sourceFamily,
             @weeklyLimitUsd, @targetProvider, @targetFamily, @now, @now)`
  );

  db.transaction(() => {
    db.prepare("DELETE FROM api_key_model_budget_rules WHERE api_key_id = ?").run(apiKeyId);
    for (const rule of prepared) {
      insert.run({ ...rule, enabled: rule.enabled ? 1 : 0, now });
    }
  })();

  return prepared;
}
