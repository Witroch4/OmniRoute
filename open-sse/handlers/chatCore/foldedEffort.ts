/**
 * Fork — carry an effort tier folded off the model id to a Claude or Responses upstream.
 *
 * `<base>-<tier>` ids are folded at model resolution (`lookupModelMeta`) into the base model
 * plus `resolvedThinkingEffort`. prepareUpstreamBody applies that tier per attempt with
 * applyDefaultReasoningEffort, but only for chat-completions targets. On the other targets the
 * tier was dropped and the model ran at its default effort:
 *   - Responses targets (gpt-6-luna, grok-4.6, Muse Spark, ...): measured on opencode-go/gpt-6-luna,
 *     4 samples each, suffix `-max` 232–574 reasoning tokens (the default) against 892–3138 for an
 *     explicit reasoning_effort=max.
 *   - Claude targets (Copilot `claude-sonnet-5.5-medium`): the request reached the upstream with
 *     no reasoning_effort at all.
 *
 * The tier is written onto the client body before translation, in the shape the source format
 * already uses; the translators then treat it exactly like an effort the client sent. An explicit
 * client effort always wins.
 *
 * Chat-completions targets are deliberately left to prepareUpstreamBody: it applies the tier to
 * the origin model of each attempt only, so a family fallback to a sibling model does not inherit
 * an effort the client chose for another model (tests/unit/suffix-effort-propagation.test.ts).
 * Writing the tier here for the other targets does make it travel with the body to a fallback;
 * that is the cost of having no per-attempt hook once the body is translated.
 *
 * Codex is excluded: it reads `resolvedThinkingEffort` itself (executors/codex/reasoningPolicy).
 */
import { CLAUDE_EFFORT_SUFFIXES } from "../../config/providerModels.ts";
import { FORMATS } from "../../translator/formats.ts";

type FoldedEffortInput = {
  provider: string | null | undefined;
  sourceFormat: string;
  targetFormat: string;
  body: unknown;
  resolvedThinkingEffort?: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasExplicitEffort(body: Record<string, unknown>): boolean {
  if (body.reasoning_effort !== undefined || body.thinking !== undefined) return true;
  if (isRecord(body.output_config) && body.output_config.effort) return true;
  const reasoning = body.reasoning;
  if (reasoning === undefined) return false;
  if (!isRecord(reasoning)) return true;
  return reasoning.effort !== undefined && reasoning.effort !== null && reasoning.effort !== "";
}

function isClaudeEffortLevel(value: string): boolean {
  return CLAUDE_EFFORT_SUFFIXES.some((level) => level === value);
}

/** Returns true when the folded tier was written onto `body`. */
export function applyFoldedEffort(input: FoldedEffortInput): boolean {
  const { provider, sourceFormat, targetFormat, body, resolvedThinkingEffort } = input;
  if (provider === "codex") return false;
  if (typeof resolvedThinkingEffort !== "string" || resolvedThinkingEffort === "") return false;
  if (targetFormat === FORMATS.CLAUDE) {
    if (!isClaudeEffortLevel(resolvedThinkingEffort)) return false;
  } else if (targetFormat !== FORMATS.OPENAI_RESPONSES) {
    return false;
  }
  if (!isRecord(body) || hasExplicitEffort(body)) return false;

  if (sourceFormat === FORMATS.OPENAI) {
    body.reasoning_effort = resolvedThinkingEffort;
    return true;
  }
  if (sourceFormat === FORMATS.OPENAI_RESPONSES) {
    body.reasoning = {
      ...(isRecord(body.reasoning) ? body.reasoning : {}),
      effort: resolvedThinkingEffort,
    };
    return true;
  }
  return false;
}
