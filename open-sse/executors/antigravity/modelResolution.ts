import {
  getMitmAlias,
  getFreshAntigravityModelsForConnection,
} from "../../../src/lib/db/models.ts";
import { resolveAntigravityModelId } from "../../config/antigravityModelAliases.ts";

const ACCOUNT_FLASH_TIERS = new Set([
  "gemini-3.7-flash-high",
  "gemini-3.7-flash-medium",
  "gemini-3.7-flash-low",
]);

/**
 * #16237: when the selected account's fresh synced catalog lists the literal tier id, send
 * it verbatim — ahead of the global MITM alias table. Fork: tiers are REAL upstream ids, so
 * upstream's other branch (rewrite to `gemini-3.7-flash-tiered` when the account only lists
 * the shared id) is not applied: no `-tiered` alias may rewrite what is dispatched. (Gemini
 * 3.7 Flash is retired here and refused before credential selection anyway.)
 */
async function resolveAccountModel(model: string, connectionId?: string): Promise<string | null> {
  if (!connectionId || !ACCOUNT_FLASH_TIERS.has(model)) return null;
  try {
    const models = await getFreshAntigravityModelsForConnection(connectionId);
    if (models.some((entry) => entry.id === model)) return model;
  } catch {
    // An unavailable DB must retain the existing MITM/static fallback.
  }
  return null;
}

/**
 * Strip provider prefixes (e.g. "antigravity/model" → "model").
 * Ensures the model name sent to the upstream API never contains a routing prefix.
 *
 * `modelIdOverride` (#3786): when the per-request Pro-family fallback chain forces a
 * specific upstream id, pass it here. It is an ALREADY-RESOLVED upstream id, so it bypasses
 * the MITM/static alias resolution and is used verbatim (after prefix stripping).
 */
export async function cleanModelName(
  model: string,
  modelIdOverride?: string,
  provider = "antigravity",
  connectionId?: string
): Promise<string> {
  if (modelIdOverride) {
    return modelIdOverride.includes("/") ? modelIdOverride.split("/").pop()! : modelIdOverride;
  }
  if (!model) return model;
  const stripped = model.includes("/") ? model.split("/").pop()! : model;
  const accountModel = await resolveAccountModel(stripped, connectionId);
  if (accountModel) return accountModel;
  const legacy = await resolveLegacyAlias(stripped, provider);
  return legacy === stripped ? resolveAntigravityModelId(stripped) : legacy;
}

async function resolveLegacyAlias(model: string, provider: string): Promise<string> {
  try {
    const mappings = await getMitmAlias(provider);
    if (!mappings || typeof mappings !== "object") return model;
    const alias = (mappings as Record<string, unknown>)[model];
    if (typeof alias !== "string" || !alias) return model;
    const prefix = `${provider}/`;
    return alias.startsWith(prefix) ? alias.slice(prefix.length) : alias;
  } catch {
    // Preserve the static fallback when the DB or stored MITM JSON is unavailable.
    return model;
  }
}
