import { getCachedSettings } from "@/lib/db/readCache";
import { resolveProviderId } from "@/shared/constants/providers";

export function isClaudeSiwcFamily(model: string): boolean {
  return /^claude-/i.test(model) && /(?:^|-)(?:opus|sonnet|haiku)(?:-|$)/i.test(model);
}

/** Defer source availability only; the single-model handler still authorizes and gates the target. */
export async function shouldDeferClaudeSiwcAvailability(
  provider: string,
  model: string,
  settings?: Record<string, unknown> | null
): Promise<boolean> {
  if (resolveProviderId(provider) !== "claude" || !isClaudeSiwcFamily(model)) return false;
  const config = (settings ?? (await getCachedSettings())).claudeSiwcContingency;
  return (
    typeof config === "object" && config !== null && "enabled" in config && config.enabled === true
  );
}
