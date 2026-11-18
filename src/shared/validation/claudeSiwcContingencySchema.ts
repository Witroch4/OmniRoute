import { z } from "zod";

export const CLAUDE_SIWC_UPSTREAM_MODEL = "witdev_siwc/gpt-terra-latest";

export const claudeSiwcContingencySchema = z
  .object({
    enabled: z.boolean(),
    targetModel: z.string().trim().max(300),
    connectionId: z.string().trim().max(100),
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
