import {
  DEFAULT_ANTIGRAVITY_CLIENT_PROFILE,
  normalizeAntigravityClientProfile,
  type AntigravityClientProfile,
} from "@/shared/constants/antigravityClientProfile";
import { getAntigravityCliCloudCodeHeaders } from "../config/antigravityCliClient.ts";
import {
  deriveAntigravityMachineId,
  getAntigravityVscodeSessionId,
  type AntigravityCredentialsLike,
} from "./antigravityIdentity.ts";
import {
  antigravityUserAgent,
  getAntigravityLoadCodeAssistMetadata,
} from "./antigravityHeaders.ts";
import { getCachedAntigravityVersion } from "./antigravityVersion.ts";

export {
  ANTIGRAVITY_CLIENT_PROFILE_VALUES,
  DEFAULT_ANTIGRAVITY_CLIENT_PROFILE,
  normalizeAntigravityClientProfile,
  type AntigravityClientProfile,
} from "@/shared/constants/antigravityClientProfile";

type AntigravityProfileCredentials = AntigravityCredentialsLike & {
  providerSpecificData?: Record<string, unknown> | null;
};

export function getAntigravityClientProfile(
  credentials?: AntigravityProfileCredentials | null
): AntigravityClientProfile {
  const fromProviderData =
    credentials?.providerSpecificData &&
    typeof credentials.providerSpecificData === "object" &&
    !Array.isArray(credentials.providerSpecificData)
      ? credentials.providerSpecificData.clientProfile
      : undefined;

  return normalizeAntigravityClientProfile(fromProviderData);
}

export function removeHeaderCaseInsensitive(headers: Record<string, string>, name: string): void {
  const lowerName = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lowerName) {
      delete headers[key];
    }
  }
}

function getProjectHeaderValue(body: unknown): string | null {
  const project =
    body && typeof body === "object" ? (body as Record<string, unknown>).project : null;
  if (typeof project !== "string" || project.trim().length === 0) return null;
  if (project === "test-project" || project === "project-id") return null;
  return project;
}

/** Headers used by OAuth/bootstrap calls (loadCodeAssist, onboardUser). */
export function getAntigravityBootstrapHeaders(
  profile: AntigravityClientProfile,
  accessToken?: string | null
): Record<string, string> {
  if (profile === "cli") {
    return getAntigravityCliCloudCodeHeaders(accessToken);
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }
  headers["User-Agent"] = antigravityUserAgent();
  headers["Client-Metadata"] = JSON.stringify(getAntigravityLoadCodeAssistMetadata());
  return headers;
}

/** Apply per-connection client identity to outbound Cloud Code content requests. */
export function applyAntigravityClientProfileHeaders(
  headers: Record<string, string>,
  credentials: AntigravityProfileCredentials | null | undefined,
  body: unknown
): AntigravityClientProfile {
  const profile = getAntigravityClientProfile(credentials);
  const version = getCachedAntigravityVersion();

  if (profile === "cli") {
    // Exact replica of the official CLI: rebuild the object so only its headers
    // remain, in its wire order (insertion order is the serialization order).
    const authorization = Object.entries(headers).find(
      ([key]) => key.toLowerCase() === "authorization"
    )?.[1];
    for (const key of Object.keys(headers)) delete headers[key];
    const token = authorization?.replace(/^Bearer\s+/i, "") || null;
    Object.assign(headers, getAntigravityCliCloudCodeHeaders(token));
    return profile;
  }

  // Legacy "ide" profile (opt-in). Not verified against the official IDE, which
  // sends none of the x-client-*/x-machine-id/x-vscode-sessionid headers.
  headers["User-Agent"] = antigravityUserAgent();
  headers["x-client-name"] = "antigravity";
  headers["x-client-version"] = version;
  const machineId = deriveAntigravityMachineId(credentials);
  if (machineId) {
    headers["x-machine-id"] = machineId;
  } else {
    removeHeaderCaseInsensitive(headers, "x-machine-id");
  }
  headers["x-vscode-sessionid"] = getAntigravityVscodeSessionId();
  removeHeaderCaseInsensitive(headers, "X-Goog-Api-Client");
  removeHeaderCaseInsensitive(headers, "Client-Metadata");

  const project = getProjectHeaderValue(body);
  if (project) {
    headers["x-goog-user-project"] = project;
  } else {
    removeHeaderCaseInsensitive(headers, "x-goog-user-project");
  }

  return profile;
}
