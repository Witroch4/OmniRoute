import { z } from "zod";

export const providerQuotaResetReferencesSchema = z.record(
  z.string().trim().min(1).max(100),
  z.object({
    connectionId: z.string().trim().min(1).max(200),
    windowKey: z.string().trim().min(1).max(100),
    windowDurationMs: z
      .number()
      .int()
      .min(1)
      .max(31 * 24 * 60 * 60_000),
  })
);

export type ProviderQuotaResetReferences = z.infer<typeof providerQuotaResetReferencesSchema>;
export type ProviderQuotaResetReference = ProviderQuotaResetReferences[string];
