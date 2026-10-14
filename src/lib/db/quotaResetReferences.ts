import { getDbInstance, isBuildPhase, isCloud } from "./core";
import {
  providerQuotaResetReferencesSchema,
  type ProviderQuotaResetReferences,
} from "@/shared/validation/quotaResetReferenceSchemas";

export function getProviderQuotaResetReferences(): ProviderQuotaResetReferences {
  if (isBuildPhase || isCloud) return {};
  const row = getDbInstance()
    .prepare("SELECT value FROM key_value WHERE namespace = 'settings' AND key = ?")
    .get("providerQuotaResetReferences") as { value: string } | undefined;
  if (!row) return {};
  // Invalid operator configuration must fail visibly instead of silently choosing
  // another account/provider's reset and granting an incorrect spending window.
  return providerQuotaResetReferencesSchema.parse(JSON.parse(row.value));
}
