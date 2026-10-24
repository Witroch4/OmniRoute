import { NextResponse } from "next/server";
import { z } from "zod";

import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { getApiKeyById } from "@/lib/db/apiKeys";
import {
  listAllFamilyMultipliers,
  MAX_FAMILY_MULTIPLIER,
  replaceFamilyMultipliers,
  type FamilyMultiplierRuleInput,
} from "@/lib/db/apiKeyModelFamilyMultipliers";
import { validateBody } from "@/shared/validation/helpers";
import * as log from "@/sse/utils/logger";

// Fork: Hard Rule #7 / t06 route-validation gate — the PUT body is validated with Zod
// (messages kept verbatim: the dashboard shows `error` as-is and the route tests match it).
const requiredText = (field: string) =>
  z
    .string({ error: `${field} is required` })
    .trim()
    .min(1, { error: `${field} is required` });

/**
 * Accepts a plain number OR a decimal string using either `.` or `,` as the
 * separator — the owner types on a pt-BR keyboard, where `,` is the natural
 * decimal key. Defense in depth alongside the client-side normalization in
 * `familyMultipliersPayload.ts`: this route must never trust the client to
 * have already normalized the value.
 */
const multiplierInput = z
  .union([z.number(), z.string()], { error: "multiplier must be a positive number" })
  .transform((value) =>
    typeof value === "string"
      ? value.trim()
        ? Number(value.trim().replace(",", "."))
        : Number.NaN
      : value
  )
  .refine((value) => Number.isFinite(value) && value > 0, {
    error: "multiplier must be a positive number",
    abort: true,
  })
  .refine((value) => value <= MAX_FAMILY_MULTIPLIER, {
    error: `multiplier must be ${MAX_FAMILY_MULTIPLIER} or less`,
  });

// Key order is the order issues are reported in: the multiplier is checked first, as before.
const familyMultiplierSchema = z.object({
  multiplier: multiplierInput,
  provider: requiredText("provider"),
  familyGlob: requiredText("familyGlob"),
  enabled: z
    .unknown()
    .optional()
    .transform((value) => value !== false),
  priority: z
    .unknown()
    .optional()
    .transform((value) => (Number.isFinite(Number(value)) ? Number(value) : 0)),
});

const familyMultipliersPayloadSchema = z.object(
  {
    // A null/undefined entry is an empty rule (reports the first missing field), not a type error.
    rules: z.array(
      z.preprocess((entry) => entry ?? {}, familyMultiplierSchema),
      { error: "rules must be an array" }
    ),
  },
  { error: "rules must be an array" }
);

/** Exported for unit tests — validates the PUT body without touching the DB. */
export function normalizeFamilyMultipliersPayload(payload: unknown): FamilyMultiplierRuleInput[] {
  const validation = validateBody(familyMultipliersPayloadSchema, payload);
  if (!validation.success) {
    throw new Error(validation.error.details[0]?.message ?? "Invalid payload");
  }
  return validation.data.rules;
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
