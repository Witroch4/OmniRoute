import { normalizeRenewalCycleMonths, parseTimestampMs } from "@/shared/utils/apiKeyRenewalCycle";

// The cutoff rule itself lives in the shared util so the dashboard can preview exactly
// what this save will write; re-exported here because every server caller already
// imports the DB-shaped helpers from this module.
export {
  resolveRenewalCycleExpiry,
  type RenewalExpiryDecision,
} from "@/shared/utils/apiKeyRenewalCycle";

type RenewalCycleRecord = Record<string, unknown>;

export interface ApiKeyRenewalCycleFields {
  renewalCycleEnabled: boolean;
  renewalCycleAnchorAt: string | null;
  renewalCycleMonths: number;
}

export function parseRenewalCycleEnabled(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}

function parseAnchorAt(value: unknown): string | null {
  const ms = parseTimestampMs(value);
  return ms === null ? null : new Date(ms).toISOString();
}

export function parseApiKeyRenewalCycleFields(
  record: RenewalCycleRecord
): ApiKeyRenewalCycleFields {
  return {
    renewalCycleEnabled: parseRenewalCycleEnabled(
      record.renewal_cycle_enabled ?? record.renewalCycleEnabled
    ),
    renewalCycleAnchorAt: parseAnchorAt(
      record.renewal_cycle_anchor_at ?? record.renewalCycleAnchorAt
    ),
    renewalCycleMonths: normalizeRenewalCycleMonths(
      record.renewal_cycle_months ?? record.renewalCycleMonths
    ),
  };
}

export function hasRenewalCycleUpdate(update: RenewalCycleRecord): boolean {
  return (
    update.renewalCycleEnabled !== undefined ||
    update.renewalCycleAnchorAt !== undefined ||
    update.renewalCycleMonths !== undefined ||
    update.renewRenewalCycle === true
  );
}

export function appendRenewalCycleUpdates(
  update: RenewalCycleRecord,
  updates: string[],
  params: {
    renewalCycleEnabled?: number;
    renewalCycleAnchorAt?: string | null;
    renewalCycleMonths?: number;
  }
) {
  if (update.renewalCycleEnabled !== undefined) {
    updates.push("renewal_cycle_enabled = @renewalCycleEnabled");
    params.renewalCycleEnabled = update.renewalCycleEnabled === true ? 1 : 0;
  }
  if (update.renewalCycleAnchorAt !== undefined) {
    updates.push("renewal_cycle_anchor_at = @renewalCycleAnchorAt");
    params.renewalCycleAnchorAt = parseAnchorAt(update.renewalCycleAnchorAt);
  }
  if (update.renewalCycleMonths !== undefined) {
    updates.push("renewal_cycle_months = @renewalCycleMonths");
    params.renewalCycleMonths = normalizeRenewalCycleMonths(update.renewalCycleMonths);
  }
}
