/**
 * OpenAI `response_format: { type: "json_schema" }` → Anthropic
 * `output_config.format` (Structured Outputs / constrained decoding).
 *
 * Why this exists: the translator used to inject the schema into the system
 * prompt for EVERY Claude request, on the premise that "Claude doesn't natively
 * support response_format". The literal half is true — Anthropic does not use
 * OpenAI's field NAME — but the conclusion stopped being true once Structured
 * Outputs shipped. Measured against production on 2026-09-04 with an otherwise
 * identical request:
 *   with output_config.format -> {"headline":"...","cta":"..."}
 *   without (control)         -> "# 💍 Casamento no Exterior..." (markdown)
 * Streaming was verified too: the constrained output arrives as normal
 * content_block_delta events, so nothing downstream needs to change.
 *
 * The upstream is stricter than a generic JSON Schema, and the exact limits
 * were probed live rather than taken from documentation (the doc list did NOT
 * match: it claims minLength/maxLength and recursion are unsupported, and both
 * were accepted). Confirmed ACCEPTED: title, description, enum, minLength,
 * maxLength, pattern, format, minItems, arrays of objects, nested objects,
 * optional properties, anyOf (how Pydantic renders Optional), default, and
 * $defs + $ref. Confirmed REJECTED, with HTTP 400:
 *   1. an object without an explicit `additionalProperties: false`
 *      ("For 'object' type, 'additionalProperties' must be explicitly set to false")
 *   2. numeric bounds ("For 'number' type, property 'minimum' is not supported")
 *
 * (1) is normalized here, because it is exactly what strict mode already means.
 * (2) cannot be normalized without silently dropping a constraint the caller
 * asked for, so it returns null and the caller keeps the prompt-injection path,
 * which still conveys the full original schema. That asymmetry is deliberate:
 * a request that works today must never start returning 400 because we got
 * more ambitious about guarantees.
 */

/** Keywords the upstream rejects outright — see (2) above. */
const UNSUPPORTED_NUMERIC_KEYWORDS = new Set([
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Returns a schema normalized for `output_config.format`, or `null` when it
 * carries something the upstream refuses — in which case the caller must fall
 * back to describing the schema in the prompt.
 */
export function toAnthropicOutputFormatSchema(schema: unknown): Record<string, unknown> | null {
  if (!isPlainObject(schema)) return null;

  let unsupported = false;

  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!isPlainObject(node)) return node;

    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (UNSUPPORTED_NUMERIC_KEYWORDS.has(key)) {
        unsupported = true;
        return node;
      }
      out[key] = walk(value);
    }

    // Every object node must say `additionalProperties: false` explicitly.
    if (out.type === "object" || isPlainObject(out.properties)) {
      out.additionalProperties = false;
    }
    return out;
  };

  const normalized = walk(schema);
  if (unsupported || !isPlainObject(normalized)) return null;
  return normalized;
}
