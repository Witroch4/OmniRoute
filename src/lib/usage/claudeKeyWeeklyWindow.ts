import { weeklyBoundaryWindowMs } from "@omniroute/open-sse/services/dailyQuotaReset.ts";
import { isFeatureFlagEnabled } from "@/shared/utils/featureFlags";

/**
 * Standard weekly reset of the Claude subscription: every Thursday 20:00 in
 * Fortaleza (UTC-3, no DST — 23:00 UTC). Anthropic resets the account on this
 * grid every week without exception.
 */
export const CLAUDE_STANDARD_RESET_TIME_ZONE = "America/Fortaleza";
export const CLAUDE_STANDARD_RESET_WEEKDAY = 4; // Thursday (0 = Sunday)
export const CLAUDE_STANDARD_RESET_HOUR = 20;

/**
 * Feature flag (env var OR dashboard switch — DB override wins over env). Off by
 * default: an API key's weekly USD window for the Claude provider turns over ONLY
 * on the standard Thursday reset. On: the key window follows the account's
 * observed reset instead, so an early reset of the account (the Claude reset
 * button, a credit refill) zeroes the keys' weekly spend in the same instant.
 */
export const CLAUDE_KEY_QUOTA_FOLLOWS_EARLY_RESET_FLAG = "CLAUDE_KEY_QUOTA_FOLLOWS_EARLY_RESET";

export function isClaudeKeyQuotaFollowingEarlyReset(): boolean {
  try {
    return isFeatureFlagEnabled(CLAUDE_KEY_QUOTA_FOLLOWS_EARLY_RESET_FLAG);
  } catch (error) {
    // An unreadable flag store must never loosen the keys' cap: keep the default.
    console.error(
      `[apiKeyUsageLimits] Failed to resolve ${CLAUDE_KEY_QUOTA_FOLLOWS_EARLY_RESET_FLAG}, using the standard Thursday reset:`,
      error instanceof Error ? error.message : error
    );
    return false;
  }
}

/**
 * The Claude weekly window an API key is measured against by default: from the
 * last standard Thursday 20:00 (Fortaleza) up to the next one. Derived from the
 * clock alone — independent of the provider-limits cache, the provider's observed
 * `resetAt` and `provider_quota_reset_events` — so nothing the account does
 * between two Thursdays can move it.
 */
export function getClaudeStandardWeeklyWindow(nowMs: number): {
  resetAtIso: string;
  windowStartIso: string;
} {
  const { startMs, resetMs } = weeklyBoundaryWindowMs(
    CLAUDE_STANDARD_RESET_TIME_ZONE,
    CLAUDE_STANDARD_RESET_WEEKDAY,
    CLAUDE_STANDARD_RESET_HOUR,
    nowMs
  );
  return {
    resetAtIso: new Date(resetMs).toISOString(),
    windowStartIso: new Date(startMs).toISOString(),
  };
}
