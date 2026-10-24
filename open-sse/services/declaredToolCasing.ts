/**
 * Restore a tool-call name to the spelling the CLIENT declared.
 *
 * Anthropic-format responses are assembled by three translators
 * (`openai-to-claude`, `gemini-to-claude`, the non-streaming
 * `responseTranslator`). Upstreams echo a function name in other casings:
 * Gemini/Antigravity hand Claude Code (which declares `Read`, `Bash`,
 * `WebSearch`) a `read` back, which it rejects ("No such tool available"), and
 * third-party Anthropic-format clients (OpenCode's `@ai-sdk/anthropic`
 * provider, pi) that declare lowercase tools must not get `Read` back for a
 * tool they declared as `read` ("No tool named Read").
 *
 * The Claude SSE passthrough already solved this for its own path (#12721):
 * never hand the client a name it did not declare — the request's `tools[]`
 * is the only authority on casing. This module lifts that rule out of
 * `utils/stream.ts` so the translate paths apply the same precedence:
 *
 *   1. alias ledger (`_toolNameMap`) non-identity hits — sanitized → original
 *   2. the request's DECLARED spelling, exact then case-insensitive
 *   3. the raw name, unchanged (server tools, bare probes, requests with no
 *      `tools[]`)
 *
 * Fork divergence from upstream #17118: upstream's step 3 is the legacy
 * `restoreClaudeToolName()` canonical-PascalCase upgrade (`read` → `Read`) for
 * names the client never declared. The fork returns the raw name instead, so a
 * name the client never declared reaches it exactly as the upstream sent it —
 * the request, not an alias table, decides casing. A genuine Claude Code client
 * declares `Read`, so an upstream that downcases it still gets `Read` back
 * (step 2).
 */

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function trimmedName(record: JsonRecord | null): string {
  return typeof record?.name === "string" ? record.name.trim() : "";
}

/**
 * The spelling one tools[] entry declares: OpenAI `function.name` first, then
 * Anthropic `name`. Empty string for entries that declare neither.
 */
function declaredNameOf(tool: unknown): string {
  const item = asRecord(tool);
  if (!item) return "";
  return trimmedName(asRecord(item.function)) || trimmedName(item);
}

/**
 * Exact- then case-insensitive lookup of `name` inside the request's tools[]
 * (Anthropic `name` or OpenAI `function.name`). Returns the DECLARED spelling,
 * or null when no declared tool matches (server tools, undeclared names).
 */
export function findDeclaredToolName(requestTools: unknown, name: string): string | null {
  if (!Array.isArray(requestTools)) return null;
  const lower = name.toLowerCase();
  let caseInsensitive: string | null = null;
  for (const tool of requestTools) {
    const declared = declaredNameOf(tool);
    if (!declared) continue;
    if (declared === name) return declared;
    if (caseInsensitive === null && declared.toLowerCase() === lower) {
      caseInsensitive = declared;
    }
  }
  return caseInsensitive;
}

/**
 * Alias-ledger (`_toolNameMap`) lookup: a non-identity hit on the sanitized or
 * original side wins. An identity echo (`read` → `read`) returns null so the
 * request's declared casing decides instead.
 */
function aliasLedgerName(map: Map<string, string>, rawName: string): string | null {
  const exact = map.get(rawName);
  if (typeof exact === "string" && exact !== rawName) return exact;
  const lower = rawName.toLowerCase();
  for (const [sanitized, original] of map.entries()) {
    if (sanitized.toLowerCase() !== lower && original.toLowerCase() !== lower) continue;
    return original !== rawName ? original : null;
  }
  return null;
}

/**
 * Tool-call name for an Anthropic-format client: alias ledger, then the
 * request's declared casing, then the raw name (fork: no canonical upgrade).
 * `clientTools` is the CLIENT request's `tools[]` — not the provider body, whose
 * names an executor (native Claude, Antigravity) may already have rewritten.
 */
export function restoreDeclaredToolName(
  rawName: string,
  toolNameMap: unknown,
  clientTools: unknown
): string {
  if (!rawName) return rawName;
  const map = toolNameMap instanceof Map ? (toolNameMap as Map<string, string>) : null;

  const aliased = map && map.size > 0 ? aliasLedgerName(map, rawName) : null;
  if (aliased !== null) return aliased;

  const declared = findDeclaredToolName(clientTools, rawName);
  if (declared !== null) return declared;

  return rawName;
}
