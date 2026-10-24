/**
 * Official Antigravity CLI (`agy`) client identity.
 *
 * Captured from the real `agy` 1.4.7 on 2026-10-24 by running it behind a local TLS
 * capture proxy that answered every request itself (nothing reached Google). All six
 * `daily-cloudcode-pa.googleapis.com/v1internal:*` calls observed (loadCodeAssist,
 * listExperiments, fetchAvailableModels, fetchUserInfo, fetchAdminControls,
 * retrieveUserQuotaSummary) carried exactly these headers, in this order:
 *
 *   User-Agent: antigravity/cli/1.4.7 (aidev_client; os_type=linux; arch=amd64; cl=1006008713; auth_method=consumer)
 *   Authorization: Bearer …
 *   Content-Type: application/json
 *   Accept-Encoding: gzip
 *
 * and the loadCodeAssist body was `{"metadata":{"ideType":"ANTIGRAVITY"}}`. Its Go OAuth
 * calls (token, userinfo) go out as `Go-http-client/1.1` over HTTP/1.1. None of the
 * official clients (this CLI, nor the IDE 2.5.5 language server or its JS) sends
 * x-client-name, x-client-version, x-machine-id, x-vscode-sessionid, X-Goog-Api-Client
 * or an Electron/Chrome User-Agent. Both binaries embed the OAuth client id the
 * `agy`/`antigravity` connections use, so this identity matches their tokens.
 *
 * `os_type`/`arch` are the host's real values, as the CLI reports them. The changelist
 * (`cl=`) identifies the exact build and MUST change together with the version: bump
 * both from a fresh capture, or override both with ANTIGRAVITY_CLI_VERSION +
 * ANTIGRAVITY_CLI_CHANGELIST (a lone override is ignored so a mismatched pair can
 * never reach the wire).
 *
 * Leaf module: no imports, safe to use from config, services and executors.
 */

export const ANTIGRAVITY_CLI_DEFAULT_VERSION = "1.4.7";
export const ANTIGRAVITY_CLI_DEFAULT_CHANGELIST = "1006008713";
export const ANTIGRAVITY_CLI_OAUTH_USER_AGENT = "Go-http-client/1.1";
export const ANTIGRAVITY_CLI_ACCEPT_ENCODING = "gzip";

const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const CHANGELIST_PATTERN = /^\d{6,12}$/;

export type AntigravityCliBuild = { version: string; changelist: string };

export function getAntigravityCliBuild(
  env: Record<string, string | undefined> = process.env
): AntigravityCliBuild {
  const version = env.ANTIGRAVITY_CLI_VERSION?.trim();
  const changelist = env.ANTIGRAVITY_CLI_CHANGELIST?.trim();
  if (
    version &&
    changelist &&
    VERSION_PATTERN.test(version) &&
    CHANGELIST_PATTERN.test(changelist)
  ) {
    return { version, changelist };
  }
  return {
    version: ANTIGRAVITY_CLI_DEFAULT_VERSION,
    changelist: ANTIGRAVITY_CLI_DEFAULT_CHANGELIST,
  };
}

export function antigravityCliOsType(platform: string = process.platform): string {
  return platform === "win32" ? "windows" : platform || "unknown";
}

export function antigravityCliArch(arch: string = process.arch): string {
  switch (arch) {
    case "x64":
      return "amd64";
    case "ia32":
      return "386";
    default:
      return arch || "unknown";
  }
}

export function antigravityCliUserAgent(
  options: {
    platform?: string;
    arch?: string;
    env?: Record<string, string | undefined>;
  } = {}
): string {
  const { version, changelist } = getAntigravityCliBuild(options.env);
  const osType = antigravityCliOsType(options.platform);
  const arch = antigravityCliArch(options.arch);
  return `antigravity/cli/${version} (aidev_client; os_type=${osType}; arch=${arch}; cl=${changelist}; auth_method=consumer)`;
}

/**
 * Headers for a Cloud Code (`v1internal:*`) call, in the CLI's wire order. Callers must
 * not add anything else: every extra header is a deviation from the official client.
 */
export function getAntigravityCliCloudCodeHeaders(
  accessToken?: string | null
): Record<string, string> {
  const headers: Record<string, string> = { "User-Agent": antigravityCliUserAgent() };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  headers["Content-Type"] = "application/json";
  headers["Accept-Encoding"] = ANTIGRAVITY_CLI_ACCEPT_ENCODING;
  return headers;
}

/** Headers for the OAuth token endpoint as the CLI's Go oauth2 client sends them. */
export function getAntigravityCliOAuthTokenHeaders(): Record<string, string> {
  return {
    "User-Agent": ANTIGRAVITY_CLI_OAUTH_USER_AGENT,
    "Content-Type": "application/x-www-form-urlencoded",
    "Accept-Encoding": ANTIGRAVITY_CLI_ACCEPT_ENCODING,
  };
}

/** Body metadata the CLI sends to loadCodeAssist/onboardUser. */
export function getAntigravityCliLoadCodeAssistMetadata(): { ideType: "ANTIGRAVITY" } {
  return { ideType: "ANTIGRAVITY" };
}
