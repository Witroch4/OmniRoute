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
import { lookupAntigravityModelEnum } from "../config/antigravityCliCatalog.ts";
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

// Key order of a schema node in the CLI's tool declarations (observed across its 12 tools);
// keys it did not show go after these in their original order.
const SCHEMA_KEY_ORDER = Object.freeze([
  "type",
  "format",
  "description",
  "nullable",
  "properties",
  "required",
  "items",
  "enum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "minimum",
  "maximum",
]);
const DECLARATION_KEY_ORDER = Object.freeze(["name", "description", "parameters"]);
// int64 fields marshal as JSON strings in the CLI's protobuf output ("minLength":"1").
const INT64_SCHEMA_KEYS: ReadonlySet<string> = new Set([
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
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

/**
 * A tool schema as the CLI writes it: upper-case `type` (OBJECT, STRING, INTEGER…), the
 * node keys in the CLI's order and `properties` sorted by name (Go marshals maps sorted).
 * Meaning is unchanged; the input is not mutated.
 */
export function canonicalizeAntigravityCliSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(canonicalizeAntigravityCliSchema);
  const node = asRecord(schema);
  if (!node) return schema;

  const next: JsonRecord = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "type" && typeof value === "string") next[key] = value.toUpperCase();
    else if (INT64_SCHEMA_KEYS.has(key) && typeof value === "number") next[key] = String(value);
    else if (key === "properties" && asRecord(value)) {
      const props: JsonRecord = {};
      for (const name of Object.keys(value as JsonRecord).sort()) {
        props[name] = canonicalizeAntigravityCliSchema((value as JsonRecord)[name]);
      }
      next[key] = props;
    } else if (key === "items" || key === "anyOf" || key === "oneOf" || key === "allOf") {
      next[key] = canonicalizeAntigravityCliSchema(value);
    } else next[key] = value;
  }
  return orderKeys(next, SCHEMA_KEY_ORDER);
}

/**
 * The CLI sends every tool as its own `{ functionDeclarations: [one] }` group; OmniRoute
 * packs them into one group. Splits the groups and canonicalizes each declaration; any
 * non-function tool (googleSearch…) stays where it was.
 */
export function canonicalizeAntigravityCliTools(tools: unknown): unknown {
  if (!Array.isArray(tools)) return tools;
  const groups: unknown[] = [];
  for (const group of tools) {
    const record = asRecord(group);
    if (!record || !Array.isArray(record.functionDeclarations)) {
      groups.push(group);
      continue;
    }
    for (const declaration of record.functionDeclarations) {
      const decl = asRecord(declaration);
      if (!decl) {
        groups.push({ ...record, functionDeclarations: [declaration] });
        continue;
      }
      const next: JsonRecord = { ...decl };
      if (decl.parameters !== undefined) {
        next.parameters = canonicalizeAntigravityCliSchema(decl.parameters);
      }
      groups.push({ ...record, functionDeclarations: [orderKeys(next, DECLARATION_KEY_ORDER)] });
    }
  }
  return groups;
}

/** `2026-10-25T10:11:29-03:00` — local time with offset, as the CLI prints it. */
export function formatAntigravityCliLocalTime(nowMs: number, timeZone: string): string {
  let zone = timeZone;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      timeZoneName: "longOffset",
    });
  } catch {
    zone = DEFAULT_CLI_TIME_ZONE;
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      timeZoneName: "longOffset",
    });
  }
  const part: Record<string, string> = {};
  for (const { type, value } of formatter.formatToParts(new Date(nowMs))) part[type] = value;
  const offset = /GMT([+-]\d{2}:\d{2})/.exec(part.timeZoneName ?? "")?.[1] ?? "+00:00";
  return `${part.year}-${part.month}-${part.day}T${part.hour}:${part.minute}:${part.second}${offset}`;
}

export const DEFAULT_CLI_TIME_ZONE = "America/Sao_Paulo";

function isTextPart(part: unknown): part is JsonRecord & { text: string } {
  const record = asRecord(part);
  return !!record && typeof record.text === "string" && record.functionResponse === undefined;
}

/**
 * The CLI wraps each user message as
 * `<USER_REQUEST>\n…\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: …\n
 * </ADDITIONAL_METADATA>`. Applied to the latest user turn only (older turns would carry
 * a stale clock and change on every request), and not to tool-result turns. The CLI's
 * `<USER_SETTINGS_CHANGE>` block is not copied: it appears only when the model setting
 * changes, which a stateless gateway cannot say truthfully.
 */
export function wrapAntigravityCliUserTurn(
  contents: unknown,
  nowMs: number,
  timeZone: string
): unknown {
  if (!Array.isArray(contents) || contents.length === 0) return contents;
  const last = asRecord(contents[contents.length - 1]);
  if (!last || last.role !== "user" || !Array.isArray(last.parts)) return contents;
  if (last.parts.some((part) => asRecord(part)?.functionResponse !== undefined)) return contents;

  const textIndexes = last.parts.flatMap((part, index) => (isTextPart(part) ? [index] : []));
  if (textIndexes.length === 0) return contents;
  const first = textIndexes[0];
  const final = textIndexes[textIndexes.length - 1];
  const suffix =
    "\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: " +
    `${formatAntigravityCliLocalTime(nowMs, timeZone)}.\n</ADDITIONAL_METADATA>`;

  const parts = last.parts.map((part, index) => {
    if (!isTextPart(part) || (index !== first && index !== final)) return part;
    const open = index === first ? "<USER_REQUEST>\n" : "";
    const close = index === final ? suffix : "";
    return { ...part, text: `${open}${part.text}${close}` };
  });
  return [...contents.slice(0, -1), { ...last, parts }];
}

/** The CLI's system instruction is one text part; OmniRoute prepends its own as a second. */
export function collapseAntigravityCliSystemInstruction(systemInstruction: unknown): unknown {
  const record = asRecord(systemInstruction);
  if (!record || !Array.isArray(record.parts) || record.parts.length < 2) return systemInstruction;
  const onlyText = record.parts.every(
    (part) => isTextPart(part) && Object.keys(part as JsonRecord).length === 1
  );
  if (!onlyText) return systemInstruction;
  const text = (record.parts as Array<{ text: string }>).map((part) => part.text).join("\n\n");
  return { ...record, parts: [{ text }] };
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
  /** IANA zone for the user-turn clock; default ANTIGRAVITY_CLI_TIMEZONE / America/Sao_Paulo. */
  timeZone?: string;
  /** Wrap the latest user turn like the CLI; default on, ANTIGRAVITY_CLI_USER_TURN_WRAP=0 turns it off. */
  wrapUserTurn?: boolean;
};

function resolveWrapUserTurn(options: AntigravityCliEnvelopeOptions): boolean {
  if (typeof options.wrapUserTurn === "boolean") return options.wrapUserTurn;
  return process.env.ANTIGRAVITY_CLI_USER_TURN_WRAP?.trim() !== "0";
}

function resolveTimeZone(options: AntigravityCliEnvelopeOptions): string {
  return options.timeZone || process.env.ANTIGRAVITY_CLI_TIMEZONE?.trim() || DEFAULT_CLI_TIME_ZONE;
}

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
  if (systemInstruction) {
    const collapsed = asRecord(collapseAntigravityCliSystemInstruction(systemInstruction));
    next.systemInstruction =
      collapsed && collapsed.role !== "user" ? { ...collapsed, role: "user" } : collapsed;
  }

  // The conversation key above was taken from the untouched contents, so wrapping the
  // latest turn does not move a conversation to a new cascade on its next request.
  const nowMs = options.nowMs ?? Date.now();
  if (next.tools !== undefined) next.tools = canonicalizeAntigravityCliTools(next.tools);
  if (resolveWrapUserTurn(options)) {
    next.contents = wrapAntigravityCliUserTurn(next.contents, nowMs, resolveTimeZone(options));
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
      result.requestId = buildAntigravityCliRequestId(cascadeId, trajectoryId, nowMs);
    } else if (key === "request") {
      result.request = orderKeys(next, ANTIGRAVITY_CLI_REQUEST_KEY_ORDER);
    } else {
      result[key] = value;
    }
  }
  return result as T;
}
