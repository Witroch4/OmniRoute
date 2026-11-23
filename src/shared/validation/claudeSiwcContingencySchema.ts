import { z } from "zod";

export const CLAUDE_SIWC_UPSTREAM_MODEL = "witdev_siwc/gpt-terra-latest";

/**
 * Segmented contingency: each Claude family goes to its own SIWC "latest" alias. The SIWC
 * gateway resolves every alias to the newest live model of that family on each call, so a new
 * Sol/Terra/Luna release is picked up without changing this configuration.
 */
export const CLAUDE_SIWC_SEGMENT_MODELS = {
  sol: "witdev_siwc/gpt-sol-latest",
  terra: CLAUDE_SIWC_UPSTREAM_MODEL,
  luna: "witdev_siwc/gpt-luna-latest",
} as const;
export type ClaudeSiwcSegment = keyof typeof CLAUDE_SIWC_SEGMENT_MODELS;

/**
 * - `single` (default, the original behaviour): Opus, Sonnet and Haiku go to Terra latest and
 *   the contingency runs BEFORE model-budget routing (which is then skipped).
 * - `segmented`: model-budget routing runs FIRST and the FINAL Claude model picks the target —
 *   Fable/Opus → Sol latest, Sonnet → Terra latest, Haiku → Luna latest.
 */
export const CLAUDE_SIWC_CONTINGENCY_MODES = ["single", "segmented"] as const;
export type ClaudeSiwcContingencyMode = (typeof CLAUDE_SIWC_CONTINGENCY_MODES)[number];

export const claudeSiwcContingencySchema = z
  .object({
    enabled: z.boolean(),
    targetModel: z.string().trim().max(300),
    connectionId: z.string().trim().max(100),
    mode: z.enum(CLAUDE_SIWC_CONTINGENCY_MODES).optional(),
  })
  .strict()
  .refine(
    (value) =>
      !value.enabled ||
      (value.connectionId.length > 0 &&
        /^[a-zA-Z0-9_-]+\/witdev_siwc\/gpt-terra-latest$/.test(value.targetModel)),
    "Enabled Claude SIWC contingency requires its configured connection and exact SIWC alias"
  );

export type ClaudeSiwcContingencySettings = z.infer<typeof claudeSiwcContingencySchema>;

/** The configured Terra target (`<node prefix>/witdev_siwc/gpt-terra-latest`) re-pointed at a segment. */
export function claudeSiwcSegmentTarget(terraTarget: string, segment: ClaudeSiwcSegment): string {
  const prefix = terraTarget.slice(0, terraTarget.length - CLAUDE_SIWC_UPSTREAM_MODEL.length);
  return `${prefix}${CLAUDE_SIWC_SEGMENT_MODELS[segment]}`;
}
