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

/**
 * Keywords MEASURED as accepted by `output_config.format` (2026-09-04 and
 * 2026-09-10, each one sent alone in a minimal schema and answered 200 with
 * content). This is an ALLOWLIST on purpose: the first version of this file
 * enumerated what the upstream REJECTS, and production found a keyword the
 * probe battery had never sent (`maxItems` → 400 "For 'array' type, property
 * 'maxItems' is not supported") on the very first real caller. A denylist can
 * only be as complete as the last probe; an allowlist fails closed — an
 * unknown keyword sends the request down the prompt path, which is exactly
 * where it went before this translator learned the native field. That keeps
 * the invariant this file exists for: a request that worked yesterday must
 * never start returning 400 because we got more ambitious.
 *
 * Measured REJECTED (kept here as documentation, never consulted at runtime):
 *   minimum, maximum, exclusiveMinimum, exclusiveMaximum, multipleOf,
 *   maxItems, uniqueItems, maxProperties, oneOf
 *   ("Schema type 'oneOf' is not supported")
 * Inconclusive (probe timed out twice; treated as unsupported until measured):
 *   minProperties
 * Metadata keywords are allowed because the upstream ignores them rather than
 * rejecting them (title, description, default, examples).
 */
const ACCEPTED_KEYWORDS = new Set([
  // structure
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "$defs",
  "definitions",
  "$ref",
  "anyOf",
  "allOf",
  // values
  "enum",
  "const",
  // string
  "minLength",
  "maxLength",
  "pattern",
  "format",
  // array
  "minItems",
  // metadata (ignored upstream)
  "title",
  "description",
  "default",
  "examples",
  "$schema",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Returns a schema normalized for `output_config.format`, or `null` when it
 * carries any keyword outside the measured-accepted set — in which case the
 * caller must fall back to describing the schema in the prompt.
 */
export function toAnthropicOutputFormatSchema(schema: unknown): Record<string, unknown> | null {
  if (!isPlainObject(schema)) return null;

  let unsupported = false;

  // `properties` / `$defs` / `definitions` map user-chosen names to schemas, so
  // their KEYS are not keywords and must not be checked against the allowlist.
  const walkMap = (node: unknown): unknown => {
    if (!isPlainObject(node)) return node;
    const out: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(node)) out[name] = walkSchema(value);
    return out;
  };

  const walkSchema = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walkSchema);
    if (!isPlainObject(node)) return node;

    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (!ACCEPTED_KEYWORDS.has(key)) {
        unsupported = true;
        return node;
      }
      out[key] =
        key === "properties" || key === "$defs" || key === "definitions"
          ? walkMap(value)
          : walkSchema(value);
    }

    // Every object node must say `additionalProperties: false` explicitly.
    if (out.type === "object" || isPlainObject(out.properties)) {
      out.additionalProperties = false;
    }
    return out;
  };

  const normalized = walkSchema(schema);
  if (unsupported || !isPlainObject(normalized)) return null;
  return normalized;
}
