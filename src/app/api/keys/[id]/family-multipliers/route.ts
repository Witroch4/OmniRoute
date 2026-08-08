import { NextResponse } from "next/server";

import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { getApiKeyById } from "@/lib/db/apiKeys";
import {
  listAllFamilyMultipliers,
  MAX_FAMILY_MULTIPLIER,
  replaceFamilyMultipliers,
  type FamilyMultiplierRuleInput,
} from "@/lib/db/apiKeyModelFamilyMultipliers";
import * as log from "@/sse/utils/logger";

function requireText(value: unknown, field: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`${field} is required`);
  return text;
}

/**
 * Accepts a plain number OR a decimal string using either `.` or `,` as the
 * separator — the owner types on a pt-BR keyboard, where `,` is the natural
 * decimal key. Defense in depth alongside the client-side normalization in
 * `familyMultipliersPayload.ts`: this route must never trust the client to
 * have already normalized the value.
 */
function parseMultiplierInput(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim()) {
    return Number(value.trim().replace(",", "."));
  }
  return Number.NaN;
}

/** Exported for unit tests — validates the PUT body without touching the DB. */
export function normalizeFamilyMultipliersPayload(payload: unknown): FamilyMultiplierRuleInput[] {
  const rules = (payload as { rules?: unknown })?.rules;
  if (!Array.isArray(rules)) throw new Error("rules must be an array");

  return rules.map((entry) => {
    const record = (entry ?? {}) as Record<string, unknown>;
    const multiplier = parseMultiplierInput(record.multiplier);
    if (!Number.isFinite(multiplier) || multiplier <= 0) {
      throw new Error("multiplier must be a positive number");
    }
    if (multiplier > MAX_FAMILY_MULTIPLIER) {
      throw new Error(`multiplier must be ${MAX_FAMILY_MULTIPLIER} or less`);
    }
    return {
      enabled: record.enabled !== false,
      priority: Number.isFinite(Number(record.priority)) ? Number(record.priority) : 0,
      provider: requireText(record.provider, "provider"),
      familyGlob: requireText(record.familyGlob, "familyGlob"),
      multiplier,
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
    return NextResponse.json({ rules: listAllFamilyMultipliers(key.id) });
  } catch (error) {
    log.error("keys", "Error fetching API key family multipliers", error);
    return NextResponse.json({ error: "Failed to fetch family multipliers" }, { status: 500 });
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

    let rules: FamilyMultiplierRuleInput[];
    try {
      rules = normalizeFamilyMultipliersPayload(await request.json());
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Invalid payload" },
        { status: 400 }
      );
    }

    return NextResponse.json({ rules: replaceFamilyMultipliers(key.id, rules) });
  } catch (error) {
    log.error("keys", "Error saving API key family multipliers", error);
    return NextResponse.json({ error: "Failed to save family multipliers" }, { status: 500 });
  }
}
