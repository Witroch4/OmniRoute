/**
 * Restore a tool-call name to the spelling the CLIENT declared in its tools[].
 *
 * Gemini/Antigravity (and some OpenAI-style upstreams) echo a function name with
 * different casing than the client declared — Claude Code declares `Read`,
 * `Bash`, `WebSearch`, and gets `read` back, which it rejects ("No such tool
 * available"). The request's tools[] is the only authority on casing, so:
 *
 *   1. alias ledger (`_toolNameMap`, sanitized → original) — an exact hit wins
 *   2. the request's DECLARED spelling, exact then case-insensitive
 *   3. the raw name, unchanged (server tools, undeclared names)
 *
 * Ported from upstream `declaredToolCasing.ts` (#17118). Fork difference: step 3
 * returns the raw name instead of upstream's legacy canonical-PascalCase upgrade,
 * so names the client never declared behave exactly as before.
 */

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function trimmedName(record: JsonRecord | null): string {
  return typeof record?.name === "string" ? record.name.trim() : "";
}

/** The spelling one tools[] entry declares: OpenAI `function.name`, then Anthropic `name`. */
function declaredNameOf(tool: unknown): string {
  const item = asRecord(tool);
  if (!item) return "";
  return trimmedName(asRecord(item.function)) || trimmedName(item);
}

/**
 * Exact- then case-insensitive lookup of `name` in the request's tools[]. Returns the
 * DECLARED spelling, or null when no declared tool matches.
 */
export function findDeclaredToolName(requestTools: unknown, name: string): string | null {
  if (!Array.isArray(requestTools) || !name) return null;
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

export function restoreDeclaredToolName(
  rawName: string,
  toolNameMap: unknown,
  clientTools: unknown
): string {
  if (!rawName) return rawName;
  if (toolNameMap instanceof Map) {
    const mapped = (toolNameMap as Map<string, string>).get(rawName);
    if (typeof mapped === "string" && mapped) return mapped;
  }
  return findDeclaredToolName(clientTools, rawName) ?? rawName;
}
