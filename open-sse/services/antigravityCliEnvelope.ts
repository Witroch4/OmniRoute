/**
 * Make an Antigravity generation envelope look like the one the official agy CLI sends.
 *
 * Captured 2026-10-25 from agy 1.4.7 behind a local TLS-terminating proxy that forwarded
 * only the CLI's start-up metadata calls and answered the generation itself (no generation
 * reached Google). An `agent` request from the CLI:
 *
 *   { project, requestId: "agent/<cascade uuid>/<epoch ms>/<trajectory uuid>/1",
 *     request: { contents, systemInstruction: { role: "user", parts }, tools,
 *                labels: { cascade_id, last_step_index, model_enum, request_id,
 *                          root_cascade_id, trajectory_id, used_claude,
 *                          used_claude_conservative, used_non_gemini_model },
 *                generationConfig: { maxOutputTokens, thinkingConfig }, sessionId },
 *     model, userAgent: "antigravity", requestType: "agent" }
 *
 * — no toolConfig even with 12 tools, no safetySettings, no topK/topP, labels in key order
 * (Go marshals the map sorted), sessionId a signed int64 shared by every request of one CLI
 * session. OmniRoute used to send `agent/<ms>/<hex>`, `sessionId` first, one sessionId per
 * account forever, a default `toolConfig: VALIDATED`, `topK: 40`/`topP: 1`, a `system` role
 * and no labels — each a cheap signal that the caller is not the CLI.
 *
 * Applied only to `agent` requests of connections on the default `cli` client profile.
 * The conversation identity (cascade id, sessionId) is derived from the account plus the
 * conversation's opening (system text + first user turn), so every turn of one
 * conversation shares it, as a CLI session does; the trajectory id is fresh per request.
 */

import { createHash, randomUUID } from "node:crypto";
import { lookupAntigravityModelEnum } from "../config/antigravityModelEnums.ts";
import { deriveAntigravitySessionId } from "./antigravityIdentity.ts";

/** Key order of `request` in the CLI's generation body; anything else goes after it. */
export const ANTIGRAVITY_CLI_REQUEST_KEY_ORDER = Object.freeze([
  "contents",
  "systemInstruction",
  "tools",
  "toolConfig",
  "labels",
  "generationConfig",
  "sessionId",
]);

// Field order inside generationConfig / thinkingConfig as the CLI marshals them.
const GENERATION_CONFIG_KEY_ORDER = Object.freeze(["maxOutputTokens", "thinkingConfig"]);
const THINKING_CONFIG_KEY_ORDER = Object.freeze([
  "includeThoughts",
  "thinkingBudget",
  "thinkingLevel",
]);

// Sampling defaults OmniRoute injected for Antigravity; the CLI sends neither.
const OMNIROUTE_DEFAULT_TOP_K = 40;
const OMNIROUTE_DEFAULT_TOP_P = 1;

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function partsText(value: unknown): string {
  const parts = asRecord(value)?.parts;
  if (!Array.isArray(parts)) return "";
  return parts
    .map((part) => {
      const record = asRecord(part);
      if (!record) return "";
      if (typeof record.text === "string") return record.text;
      return JSON.stringify(record);
    })
    .join("\n");
}

/** Stable key for "this conversation on this account". */
export function antigravityConversationKey(
  accountKey: string | null | undefined,
  request: JsonRecord
): string {
  const contents = Array.isArray(request.contents) ? request.contents : [];
  const firstUser = contents.find((content) => asRecord(content)?.role === "user");
  return createHash("sha256")
    .update(
      JSON.stringify([accountKey ?? "", partsText(request.systemInstruction), partsText(firstUser)])
    )
    .digest("hex");
}

/** A v4-shaped UUID derived from the conversation key (the CLI's cascade ids are v4). */
export function deriveAntigravityCascadeId(conversationKey: string): string {
  const bytes = Buffer.from(createHash("sha256").update(`cascade:${conversationKey}`).digest());
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function buildAntigravityCliRequestId(
  cascadeId: string,
  trajectoryId: string,
  nowMs: number
): string {
  return `agent/${cascadeId}/${nowMs}/${trajectoryId}/1`;
}

export function buildAntigravityCliLabels(input: {
  cascadeId: string;
  trajectoryId: string;
  model: string;
  stepIndex: number;
}): Record<string, string> {
  const usedClaude = /^claude/i.test(input.model) ? "true" : "false";
  const labels: Record<string, string> = {
    cascade_id: input.cascadeId,
    last_step_index: String(Math.max(0, Math.floor(input.stepIndex))),
  };
  const modelEnum = lookupAntigravityModelEnum(input.model);
  if (modelEnum) labels.model_enum = modelEnum;
  labels.request_id = `${input.trajectoryId}-0`;
  labels.root_cascade_id = input.cascadeId;
  labels.trajectory_id = input.trajectoryId;
  labels.used_claude = usedClaude;
  labels.used_claude_conservative = usedClaude;
  labels.used_non_gemini_model = /^gemini/i.test(input.model) ? "false" : "true";
  return labels;
}

/** `VALIDATED`/`AUTO` without a function allowlist is what OmniRoute added by default. */
export function isDefaultAntigravityToolConfig(toolConfig: unknown): boolean {
  const config = asRecord(asRecord(toolConfig)?.functionCallingConfig);
  if (!config) return false;
  const mode = typeof config.mode === "string" ? config.mode.toUpperCase() : "";
  const allowed = config.allowedFunctionNames;
  return (
    (mode === "VALIDATED" || mode === "AUTO") && !(Array.isArray(allowed) && allowed.length > 0)
  );
}

function orderKeys(record: JsonRecord, order: readonly string[]): JsonRecord {
  const ordered: JsonRecord = {};
  for (const key of order) {
    if (record[key] !== undefined) ordered[key] = record[key];
  }
  for (const [key, value] of Object.entries(record)) {
    if (!(key in ordered) && value !== undefined) ordered[key] = value;
  }
  return ordered;
}

export type AntigravityCliEnvelopeOptions = {
  accountKey: string | null;
  /** sessionId the translator derived per account — treated as "not chosen by the client". */
  accountSessionId?: string | null;
  nowMs?: number;
  trajectoryId?: string;
};

export function applyAntigravityCliEnvelopeIdentity<T extends JsonRecord>(
  envelope: T,
  options: AntigravityCliEnvelopeOptions
): T {
  const request = asRecord(envelope.request);
  if (!request) return envelope;
  const model = typeof envelope.model === "string" ? envelope.model : "";

  const conversationKey = antigravityConversationKey(options.accountKey, request);
  const cascadeId = deriveAntigravityCascadeId(conversationKey);
  const trajectoryId = options.trajectoryId ?? randomUUID();
  const contents = Array.isArray(request.contents) ? request.contents : [];
  const stepIndex = contents.filter((content) => asRecord(content)?.role === "model").length;

  const next: JsonRecord = { ...request };

  if (isDefaultAntigravityToolConfig(next.toolConfig)) delete next.toolConfig;

  const generationConfig = asRecord(next.generationConfig);
  if (generationConfig) {
    const cleaned = { ...generationConfig };
    if (cleaned.topK === OMNIROUTE_DEFAULT_TOP_K) delete cleaned.topK;
    if (cleaned.topP === OMNIROUTE_DEFAULT_TOP_P) delete cleaned.topP;
    const thinkingConfig = asRecord(cleaned.thinkingConfig);
    if (thinkingConfig)
      cleaned.thinkingConfig = orderKeys(thinkingConfig, THINKING_CONFIG_KEY_ORDER);
    next.generationConfig = orderKeys(cleaned, GENERATION_CONFIG_KEY_ORDER);
  }

  const systemInstruction = asRecord(next.systemInstruction);
  if (systemInstruction && systemInstruction.role !== "user") {
    next.systemInstruction = { ...systemInstruction, role: "user" };
  }

  next.labels = buildAntigravityCliLabels({ cascadeId, trajectoryId, model, stepIndex });

  const clientSessionId =
    typeof request.sessionId === "string" &&
    request.sessionId &&
    request.sessionId !== options.accountSessionId
      ? request.sessionId
      : null;
  next.sessionId =
    clientSessionId ??
    deriveAntigravitySessionId(`${options.accountKey ?? ""}\n${conversationKey}`) ??
    request.sessionId;

  const result: JsonRecord = {};
  for (const [key, value] of Object.entries(envelope)) {
    if (key === "requestId") {
      result.requestId = buildAntigravityCliRequestId(
        cascadeId,
        trajectoryId,
        options.nowMs ?? Date.now()
      );
    } else if (key === "request") {
      result.request = orderKeys(next, ANTIGRAVITY_CLI_REQUEST_KEY_ORDER);
    } else {
      result[key] = value;
    }
  }
  return result as T;
}
