import type { ProviderLimitsCacheEntry } from "@/lib/db/providerLimits";
import {
  buildApiKeyUsageLimitPercentText,
  type ApiKeyUsageLimitStatus,
} from "@/lib/usage/apiKeyUsageLimits";
import { buildErrorBody } from "@omniroute/open-sse/utils/error";
import { getProviderQuotaResetReferences } from "@/lib/db/quotaResetReferences";
import type { ProviderQuotaResetReferences } from "@/shared/validation/quotaResetReferenceSchemas";

export const INTERNAL_USAGE_COMMAND = "@@om-usage";
export const USAGE_COMMAND_DISABLED_MESSAGE = "Usage command is disabled for this API key.";
const USAGE_COMMAND_AUTH_REQUIRED_MESSAGE = "Usage command requires an authenticated API key.";
const LOCAL_USAGE_MODEL = "omniroute/local-usage";
const TEXT_PLAIN_HEADERS = { "Content-Type": "text/plain; charset=utf-8" } as const;

type JsonRecord = Record<string, unknown>;

export interface UsageCommandApiKeyMetadata {
  id: string;
  name?: string;
  allowedConnections?: string[] | null;
  allowedModels?: string[] | null;
  preferredProvider?: string | null;
  allowUsageCommand?: boolean;
  usageLimitEnabled?: boolean;
  dailyUsageLimitUsd?: number | null;
  weeklyUsageLimitUsd?: number | null;
}

interface ProviderConnectionLike {
  id: string;
  provider: string;
  isActive?: boolean;
  quotaWindowThresholds?: Record<string, number> | null;
}

export interface UsageSnapshot {
  connectionId: string;
  provider: string;
  plan: unknown;
  quotas: JsonRecord;
  quotaWindowThresholds?: Record<string, number> | null;
  resetReferenceWindowKey?: string;
}

export interface UsageCommandSelection {
  preferredProvider?: string | null;
  preferredConnectionId?: string | null;
}

interface UsageCommandQuotaPolicy {
  defaultThresholdPercent: number;
  providerWindowDefaults: Record<string, Record<string, number>>;
}

export interface InternalUsageCommandDeps {
  now?: () => number;
  isValidApiKey?: (apiKey: string) => Promise<boolean>;
  getApiKeyMetadata?: (apiKey: string) => Promise<UsageCommandApiKeyMetadata | null>;
  getProviderConnectionById?: (connectionId: string) => Promise<unknown>;
  getProviderConnections?: (filter?: JsonRecord) => Promise<unknown[]>;
  getProviderLimitsCache?: (connectionId: string) => ProviderLimitsCacheEntry | null;
  getAllProviderLimitsCache?: () => Record<string, ProviderLimitsCacheEntry>;
  getApiKeyUsageLimitStatus?: (
    metadata: UsageCommandApiKeyMetadata,
    deps?: { now?: () => number }
  ) => Promise<ApiKeyUsageLimitStatus>;
  getQuotaPolicy?: () => Promise<UsageCommandQuotaPolicy>;
  getQuotaResetReferences?: () => ProviderQuotaResetReferences;
}

type RequiredDeps = Required<InternalUsageCommandDeps>;

async function normalizeDeps(deps: InternalUsageCommandDeps = {}): Promise<RequiredDeps> {
  const auth = deps.isValidApiKey ? null : await import("@/sse/services/auth");
  const apiKeys = deps.getApiKeyMetadata ? null : await import("@/lib/db/apiKeys");
  const providers =
    deps.getProviderConnectionById && deps.getProviderConnections
      ? null
      : await import("@/lib/db/providers");
  const providerLimits =
    deps.getProviderLimitsCache && deps.getAllProviderLimitsCache
      ? null
      : await import("@/lib/db/providerLimits");
  const usageLimits = deps.getApiKeyUsageLimitStatus
    ? null
    : await import("@/lib/usage/apiKeyUsageLimits");

  return {
    now: deps.now ?? Date.now,
    isValidApiKey: deps.isValidApiKey ?? auth!.isValidApiKey,
    getApiKeyMetadata: deps.getApiKeyMetadata ?? apiKeys!.getApiKeyMetadata,
    getProviderConnectionById:
      deps.getProviderConnectionById ?? providers!.getProviderConnectionById,
    getProviderConnections: deps.getProviderConnections ?? providers!.getProviderConnections,
    getProviderLimitsCache: deps.getProviderLimitsCache ?? providerLimits!.getProviderLimitsCache,
    getAllProviderLimitsCache:
      deps.getAllProviderLimitsCache ?? providerLimits!.getAllProviderLimitsCache,
    getApiKeyUsageLimitStatus:
      deps.getApiKeyUsageLimitStatus ?? usageLimits!.getApiKeyUsageLimitStatus,
    getQuotaPolicy: deps.getQuotaPolicy ?? getDefaultUsageCommandQuotaPolicy,
    getQuotaResetReferences: deps.getQuotaResetReferences ?? getProviderQuotaResetReferences,
  };
}

async function getDefaultUsageCommandQuotaPolicy(): Promise<UsageCommandQuotaPolicy> {
  const [{ getCachedSettings }, { resolveResilienceSettings }] = await Promise.all([
    import("@/lib/db/readCache"),
    import("@/lib/resilience/settings"),
  ]);
  const resilience = resolveResilienceSettings(await getCachedSettings());
  return {
    defaultThresholdPercent: resilience.quotaPreflight.defaultThresholdPercent,
    providerWindowDefaults: resilience.quotaPreflight.providerWindowDefaults,
  };
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readHeader(request: Request, name: string): string | null {
  return request.headers.get(name) || request.headers.get(name.toLowerCase());
}

function readPathScopedToken(request: Request): string | null {
  try {
    const url = new URL(request.url, "http://localhost");
    const segments = url.pathname
      .split("/")
      .map((segment) => segment.trim())
      .filter(Boolean);

    if (segments[0] === "vscode" && segments[1]) {
      return decodeURIComponent(segments[1]).trim() || null;
    }

    if (segments[0] === "api" && segments[1] === "v1" && segments[2] === "vscode") {
      const tokenIndex = segments[3] === "raw" || segments[3] === "combos" ? 4 : 3;
      if (segments[tokenIndex]) return decodeURIComponent(segments[tokenIndex]).trim() || null;
    }
  } catch {
    return null;
  }

  return null;
}

function extractUsageCommandApiKey(request: Request): string | null {
  const authHeader = readHeader(request, "Authorization");
  if (authHeader) {
    const trimmed = authHeader.trim();
    if (trimmed.toLowerCase().startsWith("bearer ")) return trimmed.slice(7).trim() || null;
  }

  if (readHeader(request, "anthropic-version")) {
    const xApiKey = readHeader(request, "x-api-key");
    if (xApiKey?.trim()) return xApiKey.trim();
  }

  return readPathScopedToken(request);
}

function textFromContent(content: unknown): string | null {
  if (typeof content === "string") return content;

  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (typeof part === "string") {
        parts.push(part);
        continue;
      }
      if (!isRecord(part)) continue;
      const text = part.text ?? part.content;
      if (typeof text === "string") parts.push(text);
    }
    return parts.length > 0 ? parts.join("") : null;
  }

  if (isRecord(content)) {
    const text = content.text ?? content.content;
    return typeof text === "string" ? text : null;
  }

  return null;
}

function extractLastRoleText(items: unknown, role: string): string | null {
  if (!Array.isArray(items)) return null;

  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (!isRecord(item) || item.role !== role) continue;
    return textFromContent(item.content);
  }

  return null;
}

export function extractLastUserText(body: unknown): string | null {
  if (!isRecord(body)) return null;

  const messagesText = extractLastRoleText(body.messages, "user");
  if (messagesText !== null) return messagesText;

  if (typeof body.input === "string") return body.input;

  const inputText = extractLastRoleText(body.input, "user");
  if (inputText !== null) return inputText;

  return null;
}

export function isInternalUsageCommand(text: string | null | undefined): boolean {
  return typeof text === "string" && text.trim() === INTERNAL_USAGE_COMMAND;
}

function readThresholdMap(value: unknown): Record<string, number> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const numeric = Number(raw);
    if (key && Number.isFinite(numeric) && numeric >= 0 && numeric <= 100) {
      out[key] = numeric;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

function connectionFromValue(value: unknown): ProviderConnectionLike | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === "string" ? value.id : "";
  const provider = typeof value.provider === "string" ? value.provider : "";
  if (!id || !provider || value.isActive === false) return null;
  return {
    id,
    provider,
    isActive: value.isActive === true,
    quotaWindowThresholds: readThresholdMap(value.quotaWindowThresholds),
  };
}

function snapshotFromConnection(
  connection: ProviderConnectionLike,
  cache: ProviderLimitsCacheEntry | null
): UsageSnapshot | null {
  if (!cache || !isRecord(cache.quotas) || Object.keys(cache.quotas).length === 0) return null;
  return {
    connectionId: connection.id,
    provider: connection.provider,
    plan: cache.plan,
    quotas: cache.quotas,
    quotaWindowThresholds: connection.quotaWindowThresholds ?? null,
  };
}

export async function collectUsageSnapshots(
  metadata: UsageCommandApiKeyMetadata,
  deps: RequiredDeps
): Promise<UsageSnapshot[]> {
  const allowedConnections = Array.isArray(metadata.allowedConnections)
    ? metadata.allowedConnections.filter((id) => typeof id === "string" && id.trim())
    : [];

  if (allowedConnections.length > 0) {
    const snapshots: UsageSnapshot[] = [];
    for (const connectionId of allowedConnections) {
      const connection = connectionFromValue(await deps.getProviderConnectionById(connectionId));
      if (!connection) continue;
      const snapshot = snapshotFromConnection(
        connection,
        deps.getProviderLimitsCache(connection.id)
      );
      if (snapshot) snapshots.push(snapshot);
    }
    return snapshots;
  }

  const caches = deps.getAllProviderLimitsCache();
  const connections = await deps.getProviderConnections({ isActive: true });
  const snapshots: UsageSnapshot[] = [];
  for (const rawConnection of connections) {
    const connection = connectionFromValue(rawConnection);
    if (!connection) continue;
    const snapshot = snapshotFromConnection(connection, caches[connection.id] ?? null);
    if (snapshot) snapshots.push(snapshot);
  }
  return snapshots;
}

function normalizeQuotaKey(key: string): string {
  return key
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

interface QuotaMatch {
  key: string;
  quota: JsonRecord;
}

function findQuota(
  quotas: JsonRecord,
  kind: "session" | "weekly" | "weekly-sonnet"
): QuotaMatch | null {
  const entries = Object.entries(quotas).filter(([, value]) => isRecord(value));

  for (const [key, value] of entries) {
    const normalized = normalizeQuotaKey(key);
    if (kind === "session" && (normalized.includes("session") || normalized.includes("5h"))) {
      return { key, quota: value as JsonRecord };
    }
    if (
      kind === "weekly-sonnet" &&
      normalized.includes("weekly") &&
      normalized.includes("sonnet")
    ) {
      return { key, quota: value as JsonRecord };
    }
    if (
      kind === "weekly" &&
      (normalized === "weekly" || normalized.includes("weekly") || normalized.includes("7d")) &&
      !normalized.includes("sonnet")
    ) {
      return { key, quota: value as JsonRecord };
    }
  }

  return null;
}

export function formatResetIn(resetAt: string | null, now = Date.now()): string {
  if (!resetAt) return "unknown";
  const resetMs = Date.parse(resetAt);
  if (!Number.isFinite(resetMs)) return "unknown";

  const deltaMs = resetMs - now;
  if (deltaMs <= 0) return "now";

  const minuteMs = 60_000;
  const totalMinutes = Math.max(1, Math.ceil(deltaMs / minuteMs));
  const dayMinutes = 24 * 60;
  const days = Math.floor(totalMinutes / dayMinutes);
  const hours = Math.floor((totalMinutes % dayMinutes) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatPlan(plan: unknown): string {
  if (typeof plan === "string" && plan.trim()) return plan.trim();
  if (typeof plan === "number" && Number.isFinite(plan)) return String(plan);
  return "Unavailable";
}

function snapshotScore(snapshot: UsageSnapshot): number {
  let score = snapshot.provider === "claude" ? 100 : 0;
  if (findQuota(snapshot.quotas, "session")) score += 10;
  if (findQuota(snapshot.quotas, "weekly")) score += 10;
  if (findQuota(snapshot.quotas, "weekly-sonnet")) score += 10;
  if (formatPlan(snapshot.plan) !== "Unavailable") score += 1;
  return score;
}

function selectBestUsageSnapshot(snapshots: UsageSnapshot[]): UsageSnapshot | null {
  let selected: UsageSnapshot | null = null;
  let bestScore = -1;
  for (const snapshot of snapshots) {
    const score = snapshotScore(snapshot);
    if (score > bestScore) {
      selected = snapshot;
      bestScore = score;
    }
  }
  return selected;
}

function normalizeProviderId(provider: string | null | undefined): string | null {
  const normalized = provider?.trim().toLowerCase().replace(/_/g, "-");
  if (!normalized) return null;
  if (normalized === "cc" || normalized === "claude-code" || normalized === "claudecode") {
    return "claude";
  }
  return normalized;
}

function selectUsageSnapshot(
  snapshots: UsageSnapshot[],
  selection: UsageCommandSelection = {}
): UsageSnapshot | null {
  const preferredConnectionId = selection.preferredConnectionId?.trim();
  if (preferredConnectionId) {
    const snapshot = snapshots.find((entry) => entry.connectionId === preferredConnectionId);
    if (snapshot) return snapshot;
  }

  const preferredProvider = normalizeProviderId(selection.preferredProvider);
  if (preferredProvider) {
    return selectBestUsageSnapshot(
      snapshots.filter((entry) => normalizeProviderId(entry.provider) === preferredProvider)
    );
  }

  return selectBestUsageSnapshot(snapshots);
}

/**
 * Structured form of the usage command — what {@link buildUsageCommandText}
 * renders as text, exposed as data for API consumers (the OmniCopilot panel
 * asks for it via `?format=json`). Text and JSON share the exact same
 * collectors, so the two can never disagree about a number.
 *
 * NOTE on percentage semantics (#15530):
 * - JSON `provider.quotas` and `providers[].quotas` expose raw upstream
 *   snapshots (unadjusted usage and remaining numbers/percentages), alongside
 *   connection-level `quotaWindowThresholds`.
 * - Text output (`buildUsageCommandText` / terminal `@@om-usage`) renders only
 *   the key's own personal quota (`NN% left`), never the provider's windows and
 *   never scaled by the provider cutoff.
 *
 * The key design constraint is the 403 case: a key without `allowUsageCommand`
 * must reach the client as a *structured* reason, not a bare text error — a
 * caller rendering a usage panel has to be able to tell "the server does not
 * know your limits yet" apart from "this key may not ask".
 */
/** Discriminated so the caller never reads a data field off a refusal:
 * `allowed:false` carries only `error`; `allowed:true` carries the data. */
export type UsageCommandJson =
  | { allowed: false; error: { message: string } }
  | {
      allowed: true;
      /** Present only when the key opted into per-key usage limits. */
      personal: unknown | null;
      /** The selected provider snapshot, or null when nothing is cached. */
      provider: UsageSnapshot | null;
      /** Every connection's snapshot, so a panel can render Codex / Claude /
       * OpenCode side by side instead of only the selected one (#11191). The
       * single-pick in `provider` is a presentation choice for a terminal; the
       * collector already gathered all of them. */
      providers: UsageSnapshot[];
    };

export async function buildUsageCommandJson(
  metadata: UsageCommandApiKeyMetadata,
  deps: InternalUsageCommandDeps = {},
  selection: UsageCommandSelection = {}
): Promise<UsageCommandJson> {
  const resolvedDeps = await normalizeDeps(deps);
  const personal =
    metadata.usageLimitEnabled === true
      ? await resolvedDeps.getApiKeyUsageLimitStatus(
          {
            ...metadata,
            preferredProvider: selection.preferredProvider ?? metadata.preferredProvider ?? null,
          },
          { now: resolvedDeps.now }
        )
      : null;
  const snapshots = await collectUsageSnapshots(metadata, resolvedDeps);
  const provider = selectUsageSnapshot(snapshots, selection);
  return { allowed: true, personal, provider, providers: snapshots };
}

export async function buildUsageCommandText(
  metadata: UsageCommandApiKeyMetadata,
  deps: InternalUsageCommandDeps = {},
  selection: UsageCommandSelection = {}
): Promise<string> {
  const resolvedDeps = await normalizeDeps(deps);

  // The text command shows ONLY the key's personal quota, and shows it as it is:
  // what the key has spent against the limit it was given. The provider's own
  // windows (Session / Weekly) are never printed (a key holder must not see how
  // much of the shared provider account is left), and they no longer cap the
  // personal number either. A provider cutoff used to force this to 0% for every
  // key on the provider, so a key that had spent 17% of its limit read "0% left".
  // The cutoff still governs routing; it just is not this number. The admin
  // dashboard and the `?format=json` panel feed are separate surfaces.
  if (metadata.usageLimitEnabled !== true) {
    return ["Personal quota", "No usage limit configured for this API key."].join("\n");
  }

  const usageMetadata: UsageCommandApiKeyMetadata = {
    ...metadata,
    preferredProvider: selection.preferredProvider ?? metadata.preferredProvider ?? null,
  };
  const status = await resolvedDeps.getApiKeyUsageLimitStatus(usageMetadata, {
    now: resolvedDeps.now,
  });
  return ["Personal quota", buildApiKeyUsageLimitPercentText(status, resolvedDeps.now())].join(
    "\n"
  );
}

function getResponseModel(body: unknown): string {
  return isRecord(body) && typeof body.model === "string" && body.model.trim()
    ? body.model
    : LOCAL_USAGE_MODEL;
}

function inferHttpUsageCommandSelection(request: Request): UsageCommandSelection {
  try {
    const url = new URL(request.url, "http://localhost");
    return {
      preferredConnectionId:
        url.searchParams.get("connectionId")?.trim() ||
        readHeader(request, "x-omniroute-connection")?.trim() ||
        null,
      preferredProvider: url.searchParams.get("provider")?.trim() || null,
    };
  } catch {
    return {
      preferredConnectionId: readHeader(request, "x-omniroute-connection")?.trim() || null,
      preferredProvider: null,
    };
  }
}

/** `?format=json` (or `?format=JSON`) — anything else falls back to the text
 * form, which is the historical contract of this endpoint. */
function wantsUsageCommandJson(request: Request): boolean {
  try {
    const format = new URL(request.url, "http://localhost").searchParams.get("format");
    return format !== null && format.trim().toLowerCase() === "json";
  } catch {
    return false;
  }
}

function createPlainUsageCommandResponse(text: string, status = 200): Response {
  return new Response(text, { status, headers: TEXT_PLAIN_HEADERS });
}

function isAnthropicRequest(request: Request): boolean {
  if (request.headers.has("anthropic-version")) return true;
  try {
    return new URL(request.url).pathname.endsWith("/v1/messages");
  } catch {
    return false;
  }
}

function textEncoderStream(payload: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(payload));
      controller.close();
    },
  });
}

function createOpenAITextResponse(text: string, body: unknown): Response {
  const created = Math.floor(Date.now() / 1000);
  const model = getResponseModel(body);
  const payload = {
    id: `chatcmpl_usage_${created}`,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
  return Response.json(payload);
}

function createOpenAIStreamResponse(text: string, body: unknown): Response {
  const created = Math.floor(Date.now() / 1000);
  const model = getResponseModel(body);
  const id = `chatcmpl_usage_${created}`;
  const first = {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
  };
  const second = {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  };
  return new Response(
    textEncoderStream(
      `data: ${JSON.stringify(first)}\n\ndata: ${JSON.stringify(second)}\n\ndata: [DONE]\n\n`
    ),
    { headers: { "Content-Type": "text/event-stream; charset=utf-8" } }
  );
}

function createAnthropicTextResponse(text: string, body: unknown): Response {
  const payload = {
    id: `msg_usage_${Date.now()}`,
    type: "message",
    role: "assistant",
    model: getResponseModel(body),
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
  return Response.json(payload);
}

function createAnthropicStreamResponse(text: string, body: unknown): Response {
  const id = `msg_usage_${Date.now()}`;
  const model = getResponseModel(body);
  const events = [
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id,
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      },
    ],
    [
      "content_block_start",
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    ],
    [
      "content_block_delta",
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    ],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    [
      "message_delta",
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 0 },
      },
    ],
    ["message_stop", { type: "message_stop" }],
  ] as const;
  const payload = events
    .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join("");
  return new Response(textEncoderStream(payload), {
    headers: { "Content-Type": "text/event-stream; charset=utf-8" },
  });
}

export function createLocalTextResponse(request: Request, body: unknown, text: string): Response {
  const stream = isRecord(body) && body.stream === true;
  if (isAnthropicRequest(request)) {
    return stream
      ? createAnthropicStreamResponse(text, body)
      : createAnthropicTextResponse(text, body);
  }
  return stream ? createOpenAIStreamResponse(text, body) : createOpenAITextResponse(text, body);
}

export async function handleInternalUsageCommand(
  request: Request,
  body: unknown,
  deps: InternalUsageCommandDeps = {}
): Promise<Response | null> {
  const lastUserText = extractLastUserText(body);
  if (!isInternalUsageCommand(lastUserText)) return null;

  const resolvedDeps = await normalizeDeps(deps);
  const apiKey = extractUsageCommandApiKey(request);
  if (!apiKey || !(await resolvedDeps.isValidApiKey(apiKey))) {
    return createLocalTextResponse(request, body, USAGE_COMMAND_AUTH_REQUIRED_MESSAGE);
  }

  const metadata = await resolvedDeps.getApiKeyMetadata(apiKey);
  if (!metadata?.id) {
    return createLocalTextResponse(request, body, USAGE_COMMAND_AUTH_REQUIRED_MESSAGE);
  }

  if (metadata.allowUsageCommand !== true) {
    return createLocalTextResponse(request, body, USAGE_COMMAND_DISABLED_MESSAGE);
  }

  return createLocalTextResponse(
    request,
    body,
    await buildUsageCommandText(metadata, resolvedDeps)
  );
}

export async function handleInternalUsageCommandHttpRequest(
  request: Request,
  deps: InternalUsageCommandDeps = {}
): Promise<Response> {
  try {
    const resolvedDeps = await normalizeDeps(deps);
    const json = wantsUsageCommandJson(request);
    const apiKey = extractUsageCommandApiKey(request);
    if (!apiKey || !(await resolvedDeps.isValidApiKey(apiKey))) {
      if (json) {
        return Response.json(
          {
            allowed: false,
            error: { message: USAGE_COMMAND_AUTH_REQUIRED_MESSAGE },
          } satisfies UsageCommandJson,
          { status: 401 }
        );
      }
      return createPlainUsageCommandResponse(USAGE_COMMAND_AUTH_REQUIRED_MESSAGE, 401);
    }

    const metadata = await resolvedDeps.getApiKeyMetadata(apiKey);
    if (!metadata?.id) {
      if (json) {
        return Response.json(
          {
            allowed: false,
            error: { message: USAGE_COMMAND_AUTH_REQUIRED_MESSAGE },
          } satisfies UsageCommandJson,
          { status: 401 }
        );
      }
      return createPlainUsageCommandResponse(USAGE_COMMAND_AUTH_REQUIRED_MESSAGE, 401);
    }

    if (metadata.allowUsageCommand !== true) {
      if (json) {
        return Response.json(
          {
            allowed: false,
            error: { message: USAGE_COMMAND_DISABLED_MESSAGE },
          } satisfies UsageCommandJson,
          { status: 403 }
        );
      }
      return createPlainUsageCommandResponse(USAGE_COMMAND_DISABLED_MESSAGE, 403);
    }

    const selection = inferHttpUsageCommandSelection(request);
    if (json) {
      return Response.json(await buildUsageCommandJson(metadata, resolvedDeps, selection));
    }
    return createPlainUsageCommandResponse(
      await buildUsageCommandText(metadata, resolvedDeps, selection)
    );
  } catch (err) {
    const body = buildErrorBody(500, err instanceof Error ? err.message : String(err));
    return Response.json(body, { status: 500 });
  }
}
