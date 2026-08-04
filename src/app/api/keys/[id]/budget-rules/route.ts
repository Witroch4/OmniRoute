import { NextResponse } from "next/server";

import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { getApiKeyById } from "@/lib/db/apiKeys";
import {
  listAllModelBudgetRules,
  replaceModelBudgetRules,
  type ModelBudgetRuleInput,
} from "@/lib/db/apiKeyModelBudgetRules";
import * as log from "@/sse/utils/logger";

function requireText(value: unknown, field: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`${field} is required`);
  return text;
}

/** Exported for unit tests — validates the PUT body without touching the DB. */
export function normalizeBudgetRulesPayload(payload: unknown): ModelBudgetRuleInput[] {
  const rules = (payload as { rules?: unknown })?.rules;
  if (!Array.isArray(rules)) throw new Error("rules must be an array");

  return rules.map((entry) => {
    const record = (entry ?? {}) as Record<string, unknown>;
    const weeklyLimitUsd = Number(record.weeklyLimitUsd);
    if (!Number.isFinite(weeklyLimitUsd) || weeklyLimitUsd <= 0) {
      throw new Error("weeklyLimitUsd must be a positive number");
    }
    return {
      enabled: record.enabled !== false,
      priority: Number.isFinite(Number(record.priority)) ? Number(record.priority) : 0,
      sourceProvider: requireText(record.sourceProvider, "sourceProvider"),
      sourceFamily: requireText(record.sourceFamily, "sourceFamily"),
      weeklyLimitUsd,
      targetProvider: requireText(record.targetProvider, "targetProvider"),
      targetFamily: requireText(record.targetFamily, "targetFamily"),
    };
  });
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const { id } = await params;
    const key = await getApiKeyById(id);
    if (!key || typeof key.id !== "string") {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }
    return NextResponse.json({ rules: listAllModelBudgetRules(key.id) });
  } catch (error) {
    log.error("keys", "Error fetching API key budget rules", error);
    return NextResponse.json({ error: "Failed to fetch budget rules" }, { status: 500 });
  }
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const { id } = await params;
    const key = await getApiKeyById(id);
    if (!key || typeof key.id !== "string") {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    let rules: ModelBudgetRuleInput[];
    try {
      rules = normalizeBudgetRulesPayload(await request.json());
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Invalid payload" },
        { status: 400 }
      );
    }

    return NextResponse.json({ rules: replaceModelBudgetRules(key.id, rules) });
  } catch (error) {
    log.error("keys", "Error saving API key budget rules", error);
    return NextResponse.json({ error: "Failed to save budget rules" }, { status: 500 });
  }
}
