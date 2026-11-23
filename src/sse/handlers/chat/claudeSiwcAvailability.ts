import { getCachedSettings } from "@/lib/db/readCache";
import { resolveProviderId } from "@/shared/constants/providers";
import type {
  ClaudeSiwcContingencyMode,
  ClaudeSiwcSegment,
} from "@/shared/validation/claudeSiwcContingencySchema";

export function isClaudeSiwcFamily(model: string): boolean {
  return /^claude-/i.test(model) && /(?:^|-)(?:opus|sonnet|haiku)(?:-|$)/i.test(model);
}

/** Segmented mode: Fable/Opus → Sol, Sonnet → Terra, Haiku → Luna; anything else keeps its route. */
export function claudeSiwcSegmentFor(model: string): ClaudeSiwcSegment | null {
  if (!/^claude-/i.test(model)) return null;
  if (/(?:^|-)(?:fable|opus)(?:-|$)/i.test(model)) return "sol";
  if (/(?:^|-)sonnet(?:-|$)/i.test(model)) return "terra";
  if (/(?:^|-)haiku(?:-|$)/i.test(model)) return "luna";
  return null;
}

/** The segment a model is substituted with under `mode`, or null when the contingency skips it. */
export function claudeSiwcTargetSegment(
  mode: ClaudeSiwcContingencyMode,
  model: string
): ClaudeSiwcSegment | null {
  if (mode === "segmented") return claudeSiwcSegmentFor(model);
  return isClaudeSiwcFamily(model) ? "terra" : null;
}

/** `null` while the contingency is off; otherwise its mode (`single` when unset or unknown). */
export function claudeSiwcContingencyMode(config: unknown): ClaudeSiwcContingencyMode | null {
  if (typeof config !== "object" || config === null || !("enabled" in config)) return null;
  if (config.enabled !== true) return null;
  return "mode" in config && config.mode === "segmented" ? "segmented" : "single";
}

export async function getClaudeSiwcContingencyMode(
  settings?: Record<string, unknown> | null
): Promise<ClaudeSiwcContingencyMode | null> {
  return claudeSiwcContingencyMode((settings ?? (await getCachedSettings())).claudeSiwcContingency);
}

/** Defer source availability only; the single-model handler still authorizes and gates the target. */
export async function shouldDeferClaudeSiwcAvailability(
  provider: string,
  model: string,
  settings?: Record<string, unknown> | null
): Promise<boolean> {
  if (resolveProviderId(provider) !== "claude") return false;
  const mode = await getClaudeSiwcContingencyMode(settings);
  return mode !== null && claudeSiwcTargetSegment(mode, model) !== null;
}
