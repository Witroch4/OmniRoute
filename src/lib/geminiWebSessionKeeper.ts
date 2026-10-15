/**
 * Gemini Web session keeper.
 *
 * `gemini-web` connections are cookie sessions (`authType: "apikey"`), so the OAuth sweep in
 * `tokenHealthCheck.ts` never looks at them. Google re-mints `__Secure-1PSIDTS` every few
 * minutes; a pasted header that is never rotated is signed-out within minutes. This keeper does
 * the rotation a browser tab would do: it calls `accounts.google.com/RotateCookies` for every
 * active connection and writes the re-minted cookies back to the stored header.
 *
 * ⚠️ There must be ONE writer chain. The executor's headless Chromium can rotate too (the page
 * carries the rotation iframe), and a second rotator that discards its result invalidates the
 * keeper's copy. So both paths funnel through `applyGeminiWebCookieUpdates`: it reads the LATEST
 * stored header under a per-connection lock and applies only the deltas, so neither side can
 * overwrite the other with an older snapshot.
 */

import { createHash } from "node:crypto";
import { getGeminiWebGate } from "@omniroute/open-sse/services/geminiWebGate.ts";
import {
  applyCookieUpdates,
  resolveGeminiWebCookieHeader,
  rotateGeminiWebCookies,
  type CookieUpdate,
  type GeminiWebRotateOutcome,
} from "@omniroute/open-sse/services/geminiWebSession.ts";

const PROVIDER_ID = "gemini-web";
const LOG_PREFIX = "[GeminiWebSession]";
/** `lastErrorSource` written by this keeper, so it only ever clears its own verdict. */
const KEEPER_ERROR_SOURCE = "gemini_web_session_keeper";

const TICK_MS = 60_000;
const FIRST_SWEEP_DELAY_MS = 15_000;
const DEFAULT_ROTATE_INTERVAL_MS = 5 * 60_000;
const MIN_ROTATE_INTERVAL_MS = 60_000;
/** After a transport failure, try again sooner than a full interval but not every tick. */
const ERROR_RETRY_MS = 2 * 60_000;

const FALSE_ENV_VALUES = new Set(["0", "false", "no", "off"]);

// ─── Config ─────────────────────────────────────────────────────────────────

/** `GEMINI_WEB_SESSION_KEEPER=0` turns the keeper off; it is on by default. */
export function isGeminiWebSessionKeeperEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  const raw = env.GEMINI_WEB_SESSION_KEEPER?.trim().toLowerCase();
  return !raw || !FALSE_ENV_VALUES.has(raw);
}

/** `GEMINI_WEB_ROTATE_INTERVAL_MS` — how often a connection is rotated (default 5 min, min 1 min). */
export function geminiWebRotateIntervalMs(
  env: Record<string, string | undefined> = process.env
): number {
  const parsed = Number.parseInt(env.GEMINI_WEB_ROTATE_INTERVAL_MS?.trim() ?? "", 10);
  return Number.isFinite(parsed) && parsed >= MIN_ROTATE_INTERVAL_MS
    ? parsed
    : DEFAULT_ROTATE_INTERVAL_MS;
}

// ─── Types ──────────────────────────────────────────────────────────────────

export interface GeminiWebKeeperConnection {
  id: string;
  name?: string | null;
  isActive?: boolean | number | null;
  apiKey?: string | null;
  providerSpecificData?: unknown;
  testStatus?: string | null;
  lastErrorSource?: string | null;
}

export interface GeminiWebKeeperDeps {
  now(): number;
  listConnections(): Promise<GeminiWebKeeperConnection[]>;
  getConnection(id: string): Promise<GeminiWebKeeperConnection | null>;
  updateConnection(id: string, data: Record<string, unknown>): Promise<unknown>;
  rotate(cookieHeader: string): Promise<GeminiWebRotateOutcome>;
  /** True while the shared gate is cooling down after a `google.com/sorry` challenge. */
  challengeActive(): boolean;
  log: {
    info(message: string): void;
    warn(message: string): void;
  };
}

export interface GeminiWebKeeperState {
  initialized: boolean;
  running: boolean;
  timer: ReturnType<typeof setInterval> | null;
  nextDueAt: Map<string, number>;
  /** connectionId -> fingerprint of the header Google answered 401 for. */
  rejected: Map<string, string>;
}

export interface GeminiWebSweepSummary {
  skipped?: "challenge";
  rotated: number;
  unchanged: number;
  unauthorized: number;
  failed: number;
}

// ─── State ──────────────────────────────────────────────────────────────────

declare global {
  var __omnirouteGeminiWebKeeper: GeminiWebKeeperState | undefined;
}

export function createGeminiWebKeeperState(): GeminiWebKeeperState {
  return {
    initialized: false,
    running: false,
    timer: null,
    nextDueAt: new Map(),
    rejected: new Map(),
  };
}

function getKeeperState(): GeminiWebKeeperState {
  // globalThis survives HMR re-evaluation, same as the token health check.
  if (!globalThis.__omnirouteGeminiWebKeeper) {
    globalThis.__omnirouteGeminiWebKeeper = createGeminiWebKeeperState();
  }
  return globalThis.__omnirouteGeminiWebKeeper;
}

// ─── Default dependencies ───────────────────────────────────────────────────

function toKeeperConnection(row: unknown): GeminiWebKeeperConnection | null {
  if (!row || typeof row !== "object") return null;
  const record = row as Record<string, unknown>;
  if (typeof record.id !== "string") return null;
  return {
    id: record.id,
    name: typeof record.name === "string" ? record.name : null,
    isActive: record.isActive as boolean | number | null | undefined,
    apiKey: typeof record.apiKey === "string" ? record.apiKey : null,
    providerSpecificData: record.providerSpecificData,
    testStatus: typeof record.testStatus === "string" ? record.testStatus : null,
    lastErrorSource: typeof record.lastErrorSource === "string" ? record.lastErrorSource : null,
  };
}

async function loadDb() {
  return import("@/lib/localDb");
}

export function createDefaultGeminiWebKeeperDeps(): GeminiWebKeeperDeps {
  return {
    now: () => Date.now(),
    async listConnections() {
      const { getProviderConnections } = await loadDb();
      const rows = await getProviderConnections({ provider: PROVIDER_ID });
      return (rows as unknown[])
        .map(toKeeperConnection)
        .filter((row): row is GeminiWebKeeperConnection => row !== null);
    },
    async getConnection(id) {
      const { getProviderConnectionById } = await loadDb();
      return toKeeperConnection(await getProviderConnectionById(id));
    },
    async updateConnection(id, data) {
      const { updateProviderConnection } = await loadDb();
      return updateProviderConnection(id, data);
    },
    rotate: (cookieHeader) => rotateGeminiWebCookies(cookieHeader),
    challengeActive: () => getGeminiWebGate().challengeRemainingMs() > 0,
    log: {
      info: (message) => console.log(LOG_PREFIX, message),
      warn: (message) => console.warn(LOG_PREFIX, message),
    },
  };
}

// ─── Single writer ──────────────────────────────────────────────────────────

const connectionLocks = new Map<string, Promise<unknown>>();

async function withConnectionLock<T>(id: string, task: () => Promise<T>): Promise<T> {
  const previous = connectionLocks.get(id) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(task);
  const tail = run.catch(() => undefined);
  connectionLocks.set(id, tail);
  try {
    return await run;
  } finally {
    if (connectionLocks.get(id) === tail) connectionLocks.delete(id);
  }
}

/**
 * Merge cookie deltas into a connection's stored header. Reads the latest header under the
 * connection lock, so a delta can never revive an older snapshot. Returns whether the stored
 * header changed. It never creates a session: a connection without a cookie is left alone.
 */
export async function applyGeminiWebCookieUpdates(
  connectionId: string,
  updates: readonly CookieUpdate[],
  deps: Pick<
    GeminiWebKeeperDeps,
    "getConnection" | "updateConnection"
  > = createDefaultGeminiWebKeeperDeps()
): Promise<boolean> {
  if (!connectionId || updates.length === 0) return false;
  return withConnectionLock(connectionId, async () => {
    const connection = await deps.getConnection(connectionId);
    if (!connection) return false;
    const current = resolveGeminiWebCookieHeader(connection);
    if (!current) return false;
    const { header, changed } = applyCookieUpdates(current, updates);
    if (changed.length === 0) return false;
    // `apiKey` outranks the other credential fields in resolveGeminiWebCookieHeader, so the
    // merged header wins from here on whichever field the paste originally landed in.
    await deps.updateConnection(connectionId, { apiKey: header });
    return true;
  });
}

// ─── Sweep ──────────────────────────────────────────────────────────────────

function fingerprint(cookieHeader: string): string {
  return createHash("sha256").update(cookieHeader).digest("hex").slice(0, 16);
}

function hasSessionCookie(cookieHeader: string): boolean {
  return /(?:^|;\s*)__Secure-1PSID=/.test(cookieHeader);
}

function isActiveConnection(connection: GeminiWebKeeperConnection): boolean {
  return connection.isActive === undefined || connection.isActive === null
    ? true
    : Boolean(connection.isActive);
}

/** One pass over every active gemini-web connection that is due. Never throws. */
export async function sweepGeminiWebSessions(
  deps: GeminiWebKeeperDeps = createDefaultGeminiWebKeeperDeps(),
  state: GeminiWebKeeperState = getKeeperState(),
  intervalMs: number = geminiWebRotateIntervalMs()
): Promise<GeminiWebSweepSummary> {
  const summary: GeminiWebSweepSummary = { rotated: 0, unchanged: 0, unauthorized: 0, failed: 0 };
  // Google flagged this IP: do not poke accounts.google.com while the gate is cooling down.
  if (deps.challengeActive()) return { ...summary, skipped: "challenge" };

  let connections: GeminiWebKeeperConnection[];
  try {
    connections = await deps.listConnections();
  } catch (error) {
    deps.log.warn(`could not list connections: ${error instanceof Error ? error.message : error}`);
    return summary;
  }

  for (const connection of connections) {
    if (!isActiveConnection(connection)) continue;
    const cookie = resolveGeminiWebCookieHeader(connection);
    if (!cookie || !hasSessionCookie(cookie)) continue;

    const label = connection.name || connection.id;
    const print = fingerprint(cookie);
    // Google already said 401 for this exact header; only a new paste is worth another call.
    if (state.rejected.get(connection.id) === print) continue;
    if (deps.now() < (state.nextDueAt.get(connection.id) ?? 0)) continue;

    try {
      const outcome = await deps.rotate(cookie);

      if (outcome.status === "unauthorized") {
        state.rejected.set(connection.id, print);
        state.nextDueAt.delete(connection.id);
        summary.unauthorized += 1;
        deps.log.warn(
          `${label}: Google rejected the session (RotateCookies ${outcome.httpStatus}); ` +
            "paste a fresh FULL Cookie header from a signed-in gemini.google.com tab"
        );
        if (connection.testStatus !== "expired") {
          const now = new Date(deps.now()).toISOString();
          await deps.updateConnection(connection.id, {
            testStatus: "expired",
            lastError:
              "Gemini Web session rejected by Google (RotateCookies 401). Paste a fresh full Cookie header.",
            lastErrorAt: now,
            lastErrorType: "session_expired",
            lastErrorSource: KEEPER_ERROR_SOURCE,
            errorCode: "rotate_unauthorized",
          });
        }
        continue;
      }

      if (outcome.status === "error") {
        state.nextDueAt.set(connection.id, deps.now() + Math.min(intervalMs, ERROR_RETRY_MS));
        summary.failed += 1;
        deps.log.warn(`${label}: rotation failed, will retry (${outcome.message})`);
        continue;
      }

      state.rejected.delete(connection.id);
      state.nextDueAt.set(connection.id, deps.now() + intervalMs);

      if (outcome.status === "rotated") {
        await applyGeminiWebCookieUpdates(connection.id, outcome.updates, deps);
        summary.rotated += 1;
        deps.log.info(`${label}: rotated (${outcome.changed.join(", ")})`);
      } else {
        summary.unchanged += 1;
      }

      const now = new Date(deps.now()).toISOString();
      const healed =
        connection.testStatus === "expired" && connection.lastErrorSource === KEEPER_ERROR_SOURCE;
      await deps.updateConnection(
        connection.id,
        healed
          ? {
              lastHealthCheckAt: now,
              testStatus: "active",
              lastError: null,
              lastErrorAt: null,
              lastErrorType: null,
              lastErrorSource: null,
              errorCode: null,
            }
          : { lastHealthCheckAt: now }
      );
    } catch (error) {
      state.nextDueAt.set(connection.id, deps.now() + Math.min(intervalMs, ERROR_RETRY_MS));
      summary.failed += 1;
      deps.log.warn(`${label}: sweep error (${error instanceof Error ? error.message : error})`);
    }
  }
  return summary;
}

// ─── Scheduler ──────────────────────────────────────────────────────────────

/** Start the keeper (idempotent). Called once from the server's background-service init. */
export function initGeminiWebSessionKeeper(
  deps: GeminiWebKeeperDeps = createDefaultGeminiWebKeeperDeps()
): void {
  const state = getKeeperState();
  if (state.initialized || !isGeminiWebSessionKeeperEnabled()) return;
  state.initialized = true;

  const run = async () => {
    if (state.running) return;
    state.running = true;
    try {
      await sweepGeminiWebSessions(deps, state);
    } finally {
      state.running = false;
    }
  };

  deps.log.info(
    `Starting session keeper (rotate every ${Math.round(geminiWebRotateIntervalMs() / 1000)}s)`
  );
  const first = setTimeout(() => {
    void run();
    state.timer = setInterval(() => void run(), TICK_MS);
    state.timer.unref?.();
  }, FIRST_SWEEP_DELAY_MS);
  first.unref?.();
}

/** Stop the scheduler (tests / hot reload). */
export function stopGeminiWebSessionKeeper(): void {
  const state = getKeeperState();
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  state.initialized = false;
}
