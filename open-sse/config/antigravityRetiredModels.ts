// Gemini models Google retired on the Antigravity backend (`agy` / `antigravity`).
//
// Measured on 2026-10-23 with one probe per family through OmniRoute, and against
// `agy models` (CLI 1.4.6), which no longer lists any of them:
//
//   Gemini 3.5 Flash (low/medium/high)  200 with a FIXED "no longer available" notice
//   Gemini 3.6 / 3.7 Flash, 3.1 Pro, pro-agent, 3-pro-preview   404 from the upstream
//
// Both providers set `passthroughModels`, so removing an id from the catalog only
// unpublishes it: a client that still asks for it is forwarded to Google. The 404s
// then read as an account problem and arm OmniRoute's per-model lockout, and the 3.5
// notice comes back as a SUCCESS (HTTP 200) that health probes and callers read as a
// healthy answer. `findRetiredAntigravityModel` lets the chat pipeline refuse these
// ids itself, before credential selection, with a message that names the successor.
//
// Scope is deliberately the (provider, id) pair: the same Gemini ids are alive on
// GitHub Copilot and on the Gemini API, which this module never matches.

export type RetiredAntigravityModel = {
  /** Human name of the retired family, for the error message. */
  family: string;
  /** Live model(s) to use instead, written the way a client should send them. */
  replacement: string;
};

const RETIRED_PROVIDERS: ReadonlySet<string> = new Set(["agy", "antigravity", "ag"]);

const FLASH_TIERS = ["low", "medium", "high"] as const;

const RETIRED: Map<string, RetiredAntigravityModel> = new Map();

for (const version of ["3.5", "3.6", "3.7"]) {
  for (const tier of FLASH_TIERS) {
    RETIRED.set(`gemini-${version}-flash-${tier}`, {
      family: `Gemini ${version} Flash`,
      replacement: `gemini-3.8-flash-${tier}`,
    });
  }
}

// Legacy public and upstream ids that also pointed at Gemini 3.5 Flash.
for (const [id, tier] of [
  ["gemini-3.5-flash-preview", "high"],
  ["gemini-3.5-flash-extra-low", "low"],
  ["gemini-3-flash-agent", "high"],
] as const) {
  RETIRED.set(id, { family: "Gemini 3.5 Flash", replacement: `gemini-3.8-flash-${tier}` });
}

// Gemini 3.1 Pro has no successor on this backend; point at the closest live options.
for (const id of [
  "gemini-3.1-pro-high",
  "gemini-3.1-pro-low",
  "gemini-3.1-pro",
  "gemini-pro-agent",
  "gemini-3-pro-preview",
  "gemini-3-pro-high",
  "gemini-3-pro-low",
]) {
  RETIRED.set(id, {
    family: "Gemini 3.1 Pro",
    replacement: "gemini-3.8-flash-high or claude-opus-5-5-high",
  });
}

/** The retirement record for this (provider, model) pair, or null when it is not retired. */
export function findRetiredAntigravityModel(
  provider: unknown,
  model: unknown
): RetiredAntigravityModel | null {
  if (typeof provider !== "string" || typeof model !== "string") return null;
  if (!RETIRED_PROVIDERS.has(provider.trim().toLowerCase())) return null;
  return RETIRED.get(model.trim().toLowerCase()) ?? null;
}

export function retiredAntigravityModelMessage(
  provider: string,
  model: string,
  retired: RetiredAntigravityModel
): string {
  return (
    `Model "${provider}/${model}" is no longer available: Google retired ${retired.family} on ` +
    `the Antigravity backend. Use ${retired.replacement} instead.`
  );
}
