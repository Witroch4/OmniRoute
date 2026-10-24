import { NextResponse } from "next/server";
import { z } from "zod";

import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { getApiKeyById } from "@/lib/db/apiKeys";
import {
  listAllModelBudgetRules,
  replaceModelBudgetRules,
  type ModelBudgetRuleInput,
} from "@/lib/db/apiKeyModelBudgetRules";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";
import * as log from "@/sse/utils/logger";

// Fork: Hard Rule #7 / t06 route-validation gate — the PUT body is validated with Zod
// (messages kept verbatim: the dashboard shows `error` as-is and the route tests match it).
const requiredText = (field: string) =>
  z
    .string({ error: `${field} is required` })
    .trim()
    .min(1, { error: `${field} is required` });

/** A positive number sent as a number or a numeric string ("100" from a text input). */
const positiveLimit = z
  .union([z.number(), z.string()], { error: "weeklyLimitUsd must be a positive number" })
  .transform((value) => (typeof value === "string" && !value.trim() ? Number.NaN : Number(value)))
  .refine((value) => Number.isFinite(value) && value > 0, {
    error: "weeklyLimitUsd must be a positive number",
  });

// Key order is the order issues are reported in: the limit is checked first, as before.
const budgetRuleSchema = z.object({
  weeklyLimitUsd: positiveLimit,
  sourceProvider: requiredText("sourceProvider"),
  sourceFamily: requiredText("sourceFamily"),
  targetProvider: requiredText("targetProvider"),
  targetFamily: requiredText("targetFamily"),
  enabled: z
    .unknown()
    .optional()
    .transform((value) => value !== false),
  priority: z
    .unknown()
    .optional()
    .transform((value) => (Number.isFinite(Number(value)) ? Number(value) : 0)),
});

const budgetRulesPayloadSchema = z.object(
  {
    // A null/undefined entry is an empty rule (reports the first missing field), not a type error.
    rules: z.array(
      z.preprocess((entry) => entry ?? {}, budgetRuleSchema),
      { error: "rules must be an array" }
    ),
  },
  { error: "rules must be an array" }
);

/** Exported for unit tests — validates the PUT body without touching the DB. */
export function normalizeBudgetRulesPayload(payload: unknown): ModelBudgetRuleInput[] {
  const validation = validateBody(budgetRulesPayloadSchema, payload);
  if (isValidationFailure(validation)) {
    throw new Error(validation.error.details[0]?.message ?? "Invalid payload");
  }
  return validation.data.rules.map((rule) => ({
    sourceProvider: rule.sourceProvider,
    sourceFamily: rule.sourceFamily,
    weeklyLimitUsd: rule.weeklyLimitUsd,
    targetProvider: rule.targetProvider,
    targetFamily: rule.targetFamily,
    enabled: rule.enabled,
    priority: rule.priority,
  }));
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
