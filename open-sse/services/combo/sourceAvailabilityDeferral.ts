import type { IsModelAvailable, ResolvedComboTarget } from "./types.ts";

/** Optional internal routing callback. Absent/failed callbacks preserve every original gate. */
export async function shouldDeferSourceAvailability(
  availability: IsModelAvailable | null | undefined,
  target: ResolvedComboTarget
): Promise<boolean> {
  try {
    return (await availability?.deferSourceAvailability?.(target.modelStr, target)) === true;
  } catch {
    return false;
  }
}
