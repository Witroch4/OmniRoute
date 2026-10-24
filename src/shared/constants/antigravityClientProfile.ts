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

export function normalizeAntigravityClientProfile(value: unknown): AntigravityClientProfile {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "ide" || normalized === "cli") {
      return normalized;
    }
    // Read-only compatibility for values persisted before the official CLI profile
    // replaced OmniRoute's synthetic harness/sdk naming. New writes are validated
    // against ANTIGRAVITY_CLIENT_PROFILE_VALUES and cannot reintroduce these aliases.
    if (normalized === "harness" || normalized === "sdk") {
      return "cli";
    }
  }
  return DEFAULT_ANTIGRAVITY_CLIENT_PROFILE;
}

export const normalizeAntigravityClientProfileSetting = normalizeAntigravityClientProfile;
