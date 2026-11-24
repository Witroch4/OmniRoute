/**
 * `gpt-reserve` (Luna Reserve do Codex) → o Luna mais novo do registro. Fork Witroch4, 24/11/2026.
 *
 * O Codex 0.171+ manda `gpt-reserve` como `model` quando a cota normal acaba. Não é um modelo com
 * preço: a primeira chamada gravava um uso sem preço e a cota em dólar da key ficava "estourada"
 * até o reset semanal (usage_limit_exceeded, key cx-zdpxzu). Aqui ele vira o Luna mais novo
 * (`gpt-*-luna`, hoje `gpt-6-luna`), que tem preço: o gasto entra na conta como Luna, nada vira
 * grátis e nenhum preço é inventado. Acompanha a família sozinho quando o registro ganhar um Luna
 * novo, pela mesma regra do fallback de família (`resolveFamilyTargetModel`).
 *
 * Só o Codex: prefixo `codex/`, `cx/` ou nenhum. Qualquer outro nome passa intacto.
 */
import { resolveFamilyTargetModel } from "@/lib/usage/modelFamilyGlob";

const RESERVE_MODEL_ID = "gpt-reserve";
const RESERVE_PROVIDER = "codex";
const RESERVE_PREFIXES = new Set(["codex", "cx"]);
const LUNA_FAMILY_GLOB = "gpt-*-luna";

/** O id novo no mesmo formato do pedido (com o prefixo do cliente), ou null se não é o `gpt-reserve`. */
export function resolveCodexReserveAlias(model: unknown): string | null {
  if (typeof model !== "string") return null;
  const raw = model.trim();
  const slash = raw.indexOf("/");
  const prefix = slash > 0 ? raw.slice(0, slash) : "";
  const bare = slash > 0 ? raw.slice(slash + 1) : raw;
  if (bare.toLowerCase() !== RESERVE_MODEL_ID) return null;
  if (prefix && !RESERVE_PREFIXES.has(prefix.toLowerCase())) return null;
  const newest = resolveFamilyTargetModel(RESERVE_PROVIDER, LUNA_FAMILY_GLOB);
  return newest ? `${prefix || RESERVE_PROVIDER}/${newest}` : null;
}
