import {
  ANTIGRAVITY_FALLBACK_VERSION,
  getCachedAntigravityVersion,
  resolveAntigravityVersion,
} from "./antigravityVersion.ts";
import {
  ANTIGRAVITY_CLI_OAUTH_USER_AGENT,
  getAntigravityCliCloudCodeHeaders,
  getAntigravityCliLoadCodeAssistMetadata,
} from "../config/antigravityCliClient.ts";
import type { AntigravityClientProfile } from "@/shared/constants/antigravityClientProfile";

/**
 * Antigravity header utilities.
 *
 * Generates User-Agent strings and API client headers that match
 * the real Antigravity client flows.
 *
 * Based on CLIProxyAPI's misc/header_utils.go.
 */

type AntigravityHeaderProfile = "loadCodeAssist" | "fetchAvailableModels" | "models";

const ANTIGRAVITY_VERSION = ANTIGRAVITY_FALLBACK_VERSION;
// IDE desktop fingerprint synced with Antigravity-Manager v4.2.0 constants.rs.
export const ANTIGRAVITY_CHROME_VERSION = "142.0.7444.175";
export const ANTIGRAVITY_ELECTRON_VERSION = "39.2.3";
export const ANTIGRAVITY_LOAD_CODE_ASSIST_USER_AGENT = `vscode/1.X.X (Antigravity/${ANTIGRAVITY_FALLBACK_VERSION})`;
export const ANTIGRAVITY_LOAD_CODE_ASSIST_API_CLIENT = "";
export const ANTIGRAVITY_NODE_API_CLIENT = "google-api-nodejs-client/10.3.0";
// Harness/bootstrap X-Goog-Api-Client synced with CLIProxyAPI misc.AntigravityGoogAPIClientUA.
export const ANTIGRAVITY_CREDIT_PROBE_API_CLIENT = "gl-node/22.21.1";
export const ANTIGRAVITY_API_CLIENT = ANTIGRAVITY_CREDIT_PROBE_API_CLIENT;

function withOptionalBearerAuth(
  headers: Record<string, string>,
  accessToken?: string | null
): Record<string, string> {
  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }
  return headers;
}

function getAntigravityPlatformInfo(platform: NodeJS.Platform = process.platform): string {
  switch (platform) {
    case "darwin":
      return "Macintosh; Intel Mac OS X 10_15_7";
    case "win32":
      return "Windows NT 10.0; Win64; x64";
    case "linux":
    default:
      return "X11; Linux x86_64";
  }
}

/**
 * Antigravity desktop User-Agent:
 * "Antigravity/VERSION (PLATFORM) Chrome/142... Electron/39..."
 */
export function antigravityUserAgent(
  version = getCachedAntigravityVersion(),
  platform: NodeJS.Platform = process.platform
): string {
  return `Antigravity/${version} (${getAntigravityPlatformInfo(platform)}) Chrome/${ANTIGRAVITY_CHROME_VERSION} Electron/${ANTIGRAVITY_ELECTRON_VERSION}`;
}

export async function resolveAntigravityUserAgent(
  platform: NodeJS.Platform = process.platform
): Promise<string> {
  const version = await resolveAntigravityVersion();
  return antigravityUserAgent(version, platform);
}

export function antigravityNativeOAuthUserAgent(): string {
  return `vscode/1.X.X (Antigravity/${getCachedAntigravityVersion()})`;
}

/** loadCodeAssist/onboardUser body metadata, as the official CLI sends it. */
export function getAntigravityLoadCodeAssistMetadata(): Record<string, string> {
  return getAntigravityCliLoadCodeAssistMetadata();
}

export function getAntigravityLoadCodeAssistClientMetadata(): string {
  return JSON.stringify(getAntigravityLoadCodeAssistMetadata());
}

/**
 * Headers for Cloud Code calls made without a connection-specific profile (OAuth
 * connect, agy import, model discovery, quota probes). They carry the default
 * identity — the official CLI replica — whatever the call kind.
 */
export function getAntigravityHeaders(
  profile: AntigravityHeaderProfile,
  accessToken?: string | null
): Record<string, string> {
  void profile;
  return getAntigravityCliCloudCodeHeaders(accessToken);
}

/**
 * Headers for a Cloud Code call made on behalf of a connection with a known client profile
 * (upstream API name). `cli` — the default — is the official CLI replica and nothing else
 * (antigravityCliClient.ts). `ide` is the legacy opt-in profile; its full content-request
 * identity is applied by `applyAntigravityClientProfileHeaders`.
 */
export function getAntigravityContentHeaders(
  profile: AntigravityClientProfile,
  accessToken?: string | null
): Record<string, string> {
  if (profile !== "ide") return getAntigravityCliCloudCodeHeaders(accessToken);
  return withOptionalBearerAuth(
    {
      "Content-Type": "application/json",
      "User-Agent": antigravityUserAgent(),
    },
    accessToken
  );
}

/** User-Agent for the Google OAuth token/userinfo calls of a profile (upstream API name). */
export function getAntigravityOAuthUserAgent(profile: AntigravityClientProfile): string {
  return profile === "ide" ? antigravityNativeOAuthUserAgent() : ANTIGRAVITY_CLI_OAUTH_USER_AGENT;
}

/** X-Goog-Api-Client used by Antigravity's credit probe path. */
export function getAntigravityCreditProbeApiClientHeader(): string {
  return ANTIGRAVITY_CREDIT_PROBE_API_CLIENT;
}

/** X-Goog-Api-Client used by harness/native Node Antigravity paths. */
export function getAntigravityApiClientHeader(): string {
  return ANTIGRAVITY_API_CLIENT;
}

export { ANTIGRAVITY_VERSION };
