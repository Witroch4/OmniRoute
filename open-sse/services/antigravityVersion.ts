import { getAntigravityCliBuild } from "../config/antigravityCliClient.ts";

const ANTIGRAVITY_IDE_RELEASE_FEED_URL =
  "https://antigravity-auto-updater-974169037036.us-central1.run.app/releases";

export const ANTIGRAVITY_VERSION_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
export const ANTIGRAVITY_VERSION_FETCH_TIMEOUT_MS = 5_000;
// Floor for the legacy "ide" profile = the official Antigravity IDE's `ideVersion`
// (product.json of the installed IDE, 2.5.5 on 2026-10-24; upstream #16512 uses the
// same floor). The previous 4.2.0 came from a third-party tool (Antigravity-Manager)
// and is a version the IDE never shipped. The default "cli" profile does not use it.
export const ANTIGRAVITY_IDE_FALLBACK_VERSION = "2.5.5";
/** Fork name of the IDE floor, kept for existing importers. */
export const ANTIGRAVITY_FALLBACK_VERSION = ANTIGRAVITY_IDE_FALLBACK_VERSION;
// The CLI identity is pinned in open-sse/config/antigravityCliClient.ts: its version and its
// build changelist (`cl=`) must change TOGETHER, so the CLI version is never resolved from a
// release feed (a feed bump would put a version on the wire next to a stale changelist).
export const ANTIGRAVITY_CLI_FALLBACK_VERSION = getAntigravityCliBuild().version;

type VersionCache = {
  fetchedAt: number;
  version: string;
};

type ProductVersionState = {
  cache: VersionCache | null;
  inFlight: Promise<string> | null;
};

type FetchLike = typeof fetch;
type VersionParser = (payload: unknown) => string | null;

const ideState: ProductVersionState = { cache: null, inFlight: null };

function normalizeVersion(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/^v/i, "");
  const match = trimmed.match(/^(\d+\.\d+\.\d+)\b/);
  return match ? match[1] : null;
}

function compareSemver(a: string, b: string): number {
  const aParts = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const bParts = b.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < 3; i += 1) {
    if (aParts[i] !== bParts[i]) return aParts[i] - bParts[i];
  }
  return 0;
}

function pickNewestVersion(...versions: unknown[]): string | null {
  return versions
    .map((version) => normalizeVersion(version))
    .filter((version): version is string => !!version)
    .reduce<string | null>(
      (best, version) => (!best || compareSemver(version, best) > 0 ? version : best),
      null
    );
}

async function fetchJsonWithTimeout(fetchImpl: FetchLike, url: string): Promise<unknown> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ANTIGRAVITY_VERSION_FETCH_TIMEOUT_MS);

  try {
    const response = await fetchImpl(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "OmniRoute-AntigravityVersion/1.0",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Version source ${url} returned ${response.status}`);
    }

    return response.json();
  } finally {
    clearTimeout(timeoutId);
  }
}

function parseIdeReleaseFeed(payload: unknown): string | null {
  if (!Array.isArray(payload)) return null;
  return pickNewestVersion(...payload.map((entry) => (entry as { version?: unknown })?.version));
}

async function resolveProductVersion(
  state: ProductVersionState,
  fallbackVersion: string,
  sourceUrl: string,
  parsePayload: VersionParser,
  fetchImpl: FetchLike
): Promise<string> {
  const now = Date.now();
  if (state.cache && now - state.cache.fetchedAt < ANTIGRAVITY_VERSION_CACHE_TTL_MS) {
    return pickNewestVersion(state.cache.version, fallbackVersion) ?? fallbackVersion;
  }

  if (state.inFlight) {
    return state.inFlight;
  }

  state.inFlight = (async () => {
    let resolved: string | null = null;
    try {
      resolved = parsePayload(await fetchJsonWithTimeout(fetchImpl, sourceUrl));
    } catch {
      resolved = null;
    }

    const version =
      pickNewestVersion(resolved, state.cache?.version, fallbackVersion) ?? fallbackVersion;

    if (resolved) {
      state.cache = {
        fetchedAt: Date.now(),
        version,
      };
    }
    return version;
  })();

  try {
    return await state.inFlight;
  } finally {
    state.inFlight = null;
  }
}

function seedVersionCache(state: ProductVersionState, version: string, fetchedAt: number): void {
  const normalized = normalizeVersion(version);
  if (!normalized) {
    throw new TypeError(`Invalid Antigravity version: ${version}`);
  }
  state.cache = { fetchedAt, version: normalized };
}

export function resolveAntigravityIdeVersion(fetchImpl: FetchLike = fetch): Promise<string> {
  return resolveProductVersion(
    ideState,
    ANTIGRAVITY_IDE_FALLBACK_VERSION,
    ANTIGRAVITY_IDE_RELEASE_FEED_URL,
    parseIdeReleaseFeed,
    fetchImpl
  );
}

/**
 * The CLI version on the wire. Pinned (see antigravityCliClient.ts): no network lookup, the
 * value is the build pair's version (ANTIGRAVITY_CLI_VERSION + ANTIGRAVITY_CLI_CHANGELIST).
 */
export function resolveAntigravityCliVersion(_fetchImpl: FetchLike = fetch): Promise<string> {
  return Promise.resolve(getCachedAntigravityCliVersion());
}

export function getCachedAntigravityIdeVersion(): string {
  return ideState.cache?.version ?? ANTIGRAVITY_IDE_FALLBACK_VERSION;
}

export function getCachedAntigravityCliVersion(): string {
  return getAntigravityCliBuild().version;
}

export function seedAntigravityIdeVersionCache(version: string, fetchedAt = Date.now()): void {
  seedVersionCache(ideState, version, fetchedAt);
}

/**
 * Test-helper compatibility only: the CLI version is pinned together with its changelist,
 * so a seeded value is validated and then ignored (it never reaches the wire).
 */
export function seedAntigravityCliVersionCache(version: string, _fetchedAt = Date.now()): void {
  if (!normalizeVersion(version)) {
    throw new TypeError(`Invalid Antigravity version: ${version}`);
  }
}

export function clearAntigravityVersionCaches(): void {
  ideState.cache = null;
  ideState.inFlight = null;
}

// Fork names (single IDE cache) kept for existing importers.
export const resolveAntigravityVersion = resolveAntigravityIdeVersion;
export const getCachedAntigravityVersion = getCachedAntigravityIdeVersion;
export const seedAntigravityVersionCache = seedAntigravityIdeVersionCache;
export const clearAntigravityVersionCache = clearAntigravityVersionCaches;
