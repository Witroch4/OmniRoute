export const ANTIGRAVITY_CLIENT_PROFILE_VALUES = ["ide", "cli"] as const;

export type AntigravityClientProfile = (typeof ANTIGRAVITY_CLIENT_PROFILE_VALUES)[number];

// The official `agy` CLI identity is the one verified on the wire (see
// open-sse/config/antigravityCliClient.ts), so it is the default for every
// connection without an explicit choice. "ide" keeps the legacy IDE fingerprint.
export const DEFAULT_ANTIGRAVITY_CLIENT_PROFILE: AntigravityClientProfile = "cli";

export type AntigravityClientProfileSetting = AntigravityClientProfile;

export const ANTIGRAVITY_CLIENT_PROFILE_OPTIONS: Array<{
  value: AntigravityClientProfileSetting;
  labelKey: "antigravityClientProfileIde" | "antigravityClientProfileHarness";
}> = [
  { value: "cli", labelKey: "antigravityClientProfileHarness" },
  { value: "ide", labelKey: "antigravityClientProfileIde" },
];

function toNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function normalizeAntigravityClientProfile(value: unknown): AntigravityClientProfile {
  const normalized = toNonEmptyString(value)?.toLowerCase();
  if (normalized === "ide") return "ide";
  // "harness"/"sdk" were stored before the official CLI identity replaced the
  // synthetic harness fingerprint; read them as "cli".
  if (normalized === "cli" || normalized === "harness" || normalized === "sdk") {
    return "cli";
  }
  return DEFAULT_ANTIGRAVITY_CLIENT_PROFILE;
}

export const normalizeAntigravityClientProfileSetting = normalizeAntigravityClientProfile;
