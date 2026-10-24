/**
 * Runtime wire-protocol catalog for OpenCode Go models.
 *
 * Go serves each model on exactly one protocol — chat completions, Responses, Anthropic messages or
 * Google generateContent — and answers 400 ModelProtocolUnsupported on the others. The official CLI
 * learns the protocol from the models.dev catalog (`provider.npm` per model, the provider's `npm` as
 * the default), so this module reads the same source. A model the static registry has never seen then
 * routes correctly as soon as OpenCode publishes it, without a rebuild.
 *
 * Only the protocol map of the two OpenCode sections is kept (a few KB of the ~6 MB payload), in
 * memory: warmed at server boot (instrumentation-node), refreshed every 6 h on first use and on model
 * import; until it loads, the static registry decides. A failed or empty fetch never replaces a good
 * copy. No Node-only imports: providerModels.ts reaches client bundles, so this module must stay
 * portable, and it never fetches from a browser or under the test runner implicitly.
 */
export type OpencodeWireFormat = "openai" | "openai-responses" | "claude" | "gemini";
export type OpencodeCatalog = Record<string, Record<string, OpencodeWireFormat>>;

const DEFAULT_CATALOG_URL = "https://models.dev/api.json";
const CATALOG_SECTIONS = ["opencode-go", "opencode"] as const;
/** OmniRoute provider → catalog sections to consult, in order (Zen lists models Go omits). */
const LOOKUP_ORDER: Record<string, readonly string[]> = {
  "opencode-go": ["opencode-go", "opencode"],
};
const NPM_FORMAT: Record<string, OpencodeWireFormat> = {
  "@ai-sdk/openai-compatible": "openai",
  "@ai-sdk/openai": "openai-responses",
  "@ai-sdk/anthropic": "claude",
  "@ai-sdk/google": "gemini",
};
const REFRESH_MS = 6 * 60 * 60 * 1000;
const RETRY_AFTER_FAILURE_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;

let catalog: OpencodeCatalog = {};
let fetchedAt = 0;
let lastAttemptAt = 0;
let inflight: Promise<RefreshResult> | null = null;

type RefreshResult = { ok: boolean; models: number; error?: string };

const implicitFetchAllowed = () =>
  typeof window === "undefined" && typeof process.env.NODE_TEST_CONTEXT !== "string";

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Protocol per model for the OpenCode sections of a models.dev payload; unknown npm packages are skipped. */
export function parseOpencodeCatalog(raw: unknown): OpencodeCatalog {
  const result: OpencodeCatalog = {};
  const root = record(raw);
  if (!root) return result;
  for (const section of CATALOG_SECTIONS) {
    const provider = record(root[section]);
    const models = record(provider?.models);
    if (!models) continue;
    const defaultNpm = typeof provider?.npm === "string" ? provider.npm : undefined;
    const formats: Record<string, OpencodeWireFormat> = {};
    for (const [modelId, model] of Object.entries(models)) {
      const npm = record(record(model)?.provider)?.npm;
      const format = NPM_FORMAT[typeof npm === "string" ? npm : (defaultNpm ?? "")];
      if (format) formats[modelId] = format;
    }
    if (Object.keys(formats).length > 0) result[section] = formats;
  }
  return result;
}

function countModels(value: OpencodeCatalog): number {
  return Object.values(value).reduce((sum, models) => sum + Object.keys(models).length, 0);
}

/** Fetch the catalog now (deduplicated). Never throws; a bad fetch keeps the previous copy. */
export function refreshOpencodeCatalog(options?: {
  fetchImpl?: typeof fetch;
}): Promise<RefreshResult> {
  if (inflight) return inflight;
  const fetchImpl = options?.fetchImpl ?? fetch;
  lastAttemptAt = Date.now();
  inflight = (async (): Promise<RefreshResult> => {
    try {
      const url = process.env.OMNIROUTE_OPENCODE_CATALOG_URL?.trim() || DEFAULT_CATALOG_URL;
      const response = await fetchImpl(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) return { ok: false, models: 0, error: `HTTP ${response.status}` };
      const next = parseOpencodeCatalog(await response.json());
      const models = countModels(next);
      if (models === 0) return { ok: false, models: 0, error: "no OpenCode models in the catalog" };
      catalog = next;
      fetchedAt = Date.now();
      return { ok: true, models };
    } catch (error) {
      return {
        ok: false,
        models: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

function refreshIfStale(): void {
  const now = Date.now();
  if (inflight || now - fetchedAt < REFRESH_MS || now - lastAttemptAt < RETRY_AFTER_FAILURE_MS)
    return;
  void refreshOpencodeCatalog();
}

/**
 * The catalog's protocol for a model of `provider`, or null when the catalog does not list it (the
 * caller then falls back to the static registry). Synchronous; may start a background refresh.
 */
export function getOpencodeCatalogFormat(
  provider: string,
  modelId: string
): OpencodeWireFormat | null {
  const sections = LOOKUP_ORDER[provider];
  if (!sections) return null;
  if (implicitFetchAllowed()) refreshIfStale();
  for (const section of sections) {
    const format = catalog[section]?.[modelId];
    if (format) return format;
  }
  return null;
}

export function resetOpencodeCatalogForTests(): void {
  catalog = {};
  fetchedAt = 0;
  lastAttemptAt = 0;
  inflight = null;
}
