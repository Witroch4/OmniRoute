import { parseNullablePositiveNumber } from "./apiKeyUsageLimitFields";

type MinSpendRecord = Record<string, unknown>;

export interface ApiKeyMinSpendGuaranteeFields {
  minSpendGuaranteeEnabled: boolean;
  minSpendGuaranteeUsd: number | null;
}

export function parseMinSpendGuaranteeEnabled(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}

export function parseApiKeyMinSpendFields(record: MinSpendRecord): ApiKeyMinSpendGuaranteeFields {
  return {
    minSpendGuaranteeEnabled: parseMinSpendGuaranteeEnabled(
      record.min_spend_guarantee_enabled ?? record.minSpendGuaranteeEnabled
    ),
    minSpendGuaranteeUsd: parseNullablePositiveNumber(
      record.min_spend_guarantee_usd ?? record.minSpendGuaranteeUsd
    ),
  };
}

export function hasMinSpendGuaranteeUpdate(update: MinSpendRecord): boolean {
  return (
    update.minSpendGuaranteeEnabled !== undefined || update.minSpendGuaranteeUsd !== undefined
  );
}

export function appendMinSpendGuaranteeUpdates(
  update: MinSpendRecord,
  updates: string[],
  params: {
    minSpendGuaranteeEnabled?: number;
    minSpendGuaranteeUsd?: number | null;
  }
) {
  if (update.minSpendGuaranteeEnabled !== undefined) {
    updates.push("min_spend_guarantee_enabled = @minSpendGuaranteeEnabled");
    params.minSpendGuaranteeEnabled = update.minSpendGuaranteeEnabled === true ? 1 : 0;
  }
  if (update.minSpendGuaranteeUsd !== undefined) {
    updates.push("min_spend_guarantee_usd = @minSpendGuaranteeUsd");
    params.minSpendGuaranteeUsd = parseNullablePositiveNumber(update.minSpendGuaranteeUsd);
  }
}
