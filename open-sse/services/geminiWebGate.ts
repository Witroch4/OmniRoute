/**
 * Gemini Web request gate — serialization and pacing for the cookie-session provider.
 *
 * Gemini Web is a consumer web session driven through a real browser (Playwright). Each
 * request launches Chromium, loads gemini.google.com and types into the page, so two things
 * need a hard ceiling that the generic request queue (`withRateLimit`) cannot give:
 *
 *   1. Google. Bursts from one account/IP draw the "unusual traffic" interstitial
 *      (HTTP 429 → google.com/sorry + reCAPTCHA) and can flag the account. Requests for the
 *      same account are therefore limited to a couple at a time (like two open tabs), with
 *      their STARTS staggered by a minimum human-ish interval, and capped per sliding
 *      window — the page-load RATE is what trips the challenge, not concurrency. When Google
 *      does challenge us, a global cooldown stops EVERYTHING (queued requests included)
 *      instead of hammering through the challenge.
 *   2. The host. Every request is a Chromium process; the production box is a small ARM
 *      board. A global cap bounds how many run at once.
 *
 * Why this lives in the executor and not in `rateLimitManager`: `withRateLimit` is a no-op
 * unless the connection is explicitly protected (or is an API-key provider), its defaults
 * are "infinite", and some callers (the dashboard model tester) bypass it entirely. The
 * cost being protected is intrinsic to this executor, so the guard travels with it.
 *
 * Rejections are `GeminiWebGateError` (HTTP 429 + `retryAfterMs`) — never silent waiting
 * past `maxQueueWaitMs`, never an unbounded queue.
 */
import { createHash } from "node:crypto";
import { SlidingWindowLimiter, type RateLimitWindow } from "./slidingWindowLimiter.ts";

// ─── Config ─────────────────────────────────────────────────────────────────

export interface GeminiWebGateConfig {
  /** Max Chromium sessions running at once, across all accounts. */
  maxBrowsers: number;
  /** Max requests running at once for ONE account (two open tabs, not a swarm). */
  maxConcurrentPerAccount: number;
  /** Minimum gap between two consecutive STARTS (and after an END) of the same account. */
  minIntervalMs: number;
  /** Random extra gap (0..jitterMs) added to `minIntervalMs`, so pacing is not metronomic. */
  jitterMs: number;
  /** Hard cap per account in any trailing window; beyond it requests are rejected, not queued. */
  window: RateLimitWindow;
  /** Max requests per account that are running or waiting. */
  maxQueueDepth: number;
  /** Max time one request may wait for its turn before being rejected. */
  maxQueueWaitMs: number;
  /** How long ALL requests are refused after Google serves a challenge / 429. */
  challengeCooldownMs: number;
}

export const DEFAULT_GEMINI_WEB_GATE_CONFIG: GeminiWebGateConfig = {
  maxBrowsers: 2,
  maxConcurrentPerAccount: 2,
  minIntervalMs: 8_000,
  jitterMs: 4_000,
  window: { requests: 12, windowMs: 10 * 60_000 },
  maxQueueDepth: 4,
  maxQueueWaitMs: 120_000,
  challengeCooldownMs: 15 * 60_000,
};

function readInt(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
  min: number
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

export function loadGeminiWebGateConfig(
  env: Record<string, string | undefined> = process.env
): GeminiWebGateConfig {
  const d = DEFAULT_GEMINI_WEB_GATE_CONFIG;
  return {
    maxBrowsers: readInt(env, "GEMINI_WEB_MAX_BROWSERS", d.maxBrowsers, 1),
    maxConcurrentPerAccount: readInt(
      env,
      "GEMINI_WEB_MAX_CONCURRENT_PER_ACCOUNT",
      d.maxConcurrentPerAccount,
      1
    ),
    minIntervalMs: readInt(env, "GEMINI_WEB_MIN_INTERVAL_MS", d.minIntervalMs, 0),
    jitterMs: readInt(env, "GEMINI_WEB_JITTER_MS", d.jitterMs, 0),
    window: {
      // 0 disables the per-window cap (SlidingWindowLimiter treats non-positive as "no limit").
      requests: readInt(env, "GEMINI_WEB_RATE_LIMIT_REQUESTS", d.window.requests, 0),
      windowMs: readInt(env, "GEMINI_WEB_RATE_LIMIT_WINDOW_MS", d.window.windowMs, 1),
    },
    maxQueueDepth: readInt(env, "GEMINI_WEB_MAX_QUEUE_DEPTH", d.maxQueueDepth, 1),
    maxQueueWaitMs: readInt(env, "GEMINI_WEB_MAX_QUEUE_WAIT_MS", d.maxQueueWaitMs, 1),
    challengeCooldownMs: readInt(env, "GEMINI_WEB_CHALLENGE_COOLDOWN_MS", d.challengeCooldownMs, 0),
  };
}

// ─── Errors ─────────────────────────────────────────────────────────────────

export type GeminiWebGateCode =
  "rate_window" | "queue_full" | "queue_timeout" | "upstream_challenge";

/** A request the gate refused. Always HTTP 429; `retryAfterMs` feeds the Retry-After header. */
export class GeminiWebGateError extends Error {
  readonly status = 429;
  readonly code: GeminiWebGateCode;
  readonly retryAfterMs: number;

  constructor(code: GeminiWebGateCode, message: string, retryAfterMs: number) {
    super(message);
    this.name = "GeminiWebGateError";
    this.code = code;
    this.retryAfterMs = Math.max(1_000, Math.ceil(retryAfterMs));
  }
}

function abortError(signal: AbortSignal | null | undefined): Error {
  const reason = signal?.reason;
  // A fresh Error, never the reason itself: AbortSignal.timeout() aborts with a DOMException
  // whose `name` is a getter-only accessor, so renaming the reason threw a TypeError instead
  // of rejecting with an AbortError (found by the 3.8.53 sync's #7286 suite).
  const err = new Error(
    reason instanceof Error
      ? reason.message
      : typeof reason === "string"
        ? reason
        : "The operation was aborted",
    reason instanceof Error ? { cause: reason } : undefined
  );
  err.name = "AbortError";
  return err;
}

// ─── FIFO semaphore ─────────────────────────────────────────────────────────

interface AcquireOptions {
  signal?: AbortSignal | null;
  timeoutMs: number;
  onTimeout: () => Error;
}

/** FIFO counting semaphore whose waiters can time out or be aborted without losing a permit. */
class FifoSemaphore {
  private permits: number;
  private readonly waiters: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = Math.max(1, permits);
  }

  acquire({ signal, timeoutMs, onTimeout }: AcquireOptions): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortError(signal));
    if (this.permits > 0 && this.waiters.length === 0) {
      this.permits--;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const drop = () => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
      };
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const waiter = () => {
        if (settled) {
          // Cannot happen (settled waiters are dropped synchronously) — but never lose a permit.
          this.release();
          return;
        }
        settled = true;
        cleanup();
        resolve();
      };
      const onAbort = () => {
        if (settled) return;
        settled = true;
        cleanup();
        drop();
        reject(abortError(signal));
      };
      const timer = setTimeout(
        () => {
          if (settled) return;
          settled = true;
          cleanup();
          drop();
          reject(onTimeout());
        },
        Math.max(0, timeoutMs)
      );
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.permits++;
  }
}

// ─── Gate ───────────────────────────────────────────────────────────────────

export interface GeminiWebPermit {
  /** Idempotent. Must be called when the request is done, success or failure. */
  release(): void;
}

interface AccountState {
  lock: FifoSemaphore;
  /** Requests running or waiting for this account. */
  pending: number;
  /** Earliest moment the next request of this account may start (ms epoch); 0 = no constraint. */
  nextStartAt: number;
}

export interface GeminiWebGateStats {
  accounts: number;
  pending: number;
  challengeRemainingMs: number;
  challengeReason: string | null;
}

export interface GeminiWebGateOptions {
  now?: () => number;
  random?: () => number;
  /** Abort-aware sleep. Default: setTimeout. */
  sleep?: (ms: number, signal?: AbortSignal | null) => Promise<void>;
}

const MAX_ACCOUNT_STATES = 500;

function defaultSleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class GeminiWebGate {
  private readonly accounts = new Map<string, AccountState>();
  private readonly browsers: FifoSemaphore;
  private readonly windowLimiter: SlidingWindowLimiter;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal | null) => Promise<void>;
  private challengeUntil = 0;
  private challengeReason: string | null = null;

  constructor(
    readonly config: GeminiWebGateConfig = loadGeminiWebGateConfig(),
    opts: GeminiWebGateOptions = {}
  ) {
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
    this.sleep = opts.sleep ?? defaultSleep;
    this.browsers = new FifoSemaphore(config.maxBrowsers);
    this.windowLimiter = new SlidingWindowLimiter({ now: this.now });
  }

  /** Remaining global cooldown after a Google challenge, 0 when clear. */
  challengeRemainingMs(): number {
    return Math.max(0, this.challengeUntil - this.now());
  }

  /**
   * Google served a challenge / 429 (`google.com/sorry`). Refuse every request — running
   * queue included — until the cooldown elapses. Never shortens an active cooldown.
   */
  tripChallengeCooldown(reason: string, ms: number = this.config.challengeCooldownMs): void {
    const until = this.now() + Math.max(0, ms);
    if (until > this.challengeUntil) {
      this.challengeUntil = until;
      this.challengeReason = reason;
    }
  }

  stats(): GeminiWebGateStats {
    let pending = 0;
    for (const st of this.accounts.values()) pending += st.pending;
    return {
      accounts: this.accounts.size,
      pending,
      challengeRemainingMs: this.challengeRemainingMs(),
      challengeReason: this.challengeRemainingMs() > 0 ? this.challengeReason : null,
    };
  }

  /**
   * Wait for this account's turn and a free browser slot. Resolves with a permit the caller
   * MUST release; rejects with `GeminiWebGateError` (429) or an AbortError.
   */
  async acquire(accountKey: string, signal?: AbortSignal | null): Promise<GeminiWebPermit> {
    const cfg = this.config;
    this.assertNoChallenge();

    const st = this.account(accountKey);
    if (st.pending >= cfg.maxQueueDepth) {
      throw new GeminiWebGateError(
        "queue_full",
        `Gemini Web queue is full for this account (${st.pending}/${cfg.maxQueueDepth} requests ` +
          `running or waiting). This is OmniRoute's local protection for the web session, not a ` +
          `Google error — retry shortly.`,
        Math.max(cfg.minIntervalMs, 5_000)
      );
    }

    // Consumed at admission, so a flood is refused up front instead of piling into the queue.
    const slot = this.windowLimiter.tryAcquire(accountKey, cfg.window);
    if (!slot.allowed) {
      throw new GeminiWebGateError(
        "rate_window",
        `Gemini Web rate cap reached for this account (${cfg.window.requests} requests per ` +
          `${Math.round(cfg.window.windowMs / 1000)}s). This is OmniRoute's local protection to ` +
          `keep the web session from being flagged — retry after the window frees a slot.`,
        slot.retryAfterMs
      );
    }

    const deadline = this.now() + cfg.maxQueueWaitMs;
    const timeout = () =>
      new GeminiWebGateError(
        "queue_timeout",
        `Gemini Web request waited more than ${Math.round(cfg.maxQueueWaitMs / 1000)}s for its ` +
          `turn (at most ${cfg.maxConcurrentPerAccount} run at once per account). Retry shortly.`,
        Math.max(cfg.minIntervalMs, 5_000)
      );

    st.pending++;
    let accountHeld = false;
    let browserHeld = false;
    try {
      await st.lock.acquire({ signal, timeoutMs: cfg.maxQueueWaitMs, onTimeout: timeout });
      accountHeld = true;

      // Reserve a start slot synchronously (before any await), so two requests that pass the
      // lock together cannot both pick the same instant. Jitter keeps it from being metronomic.
      const gap =
        cfg.minIntervalMs + (cfg.jitterMs > 0 ? Math.floor(this.random() * cfg.jitterMs) : 0);
      const startAt = Math.max(this.now(), st.nextStartAt);
      st.nextStartAt = startAt + gap;
      const waitMs = startAt - this.now();
      if (waitMs > 0) {
        if (this.now() + waitMs > deadline) throw timeout();
        await this.sleep(waitMs, signal);
      }

      await this.browsers.acquire({
        signal,
        timeoutMs: Math.max(0, deadline - this.now()),
        onTimeout: timeout,
      });
      browserHeld = true;

      // Another request may have tripped the cooldown while this one was queued.
      this.assertNoChallenge();
    } catch (err) {
      if (browserHeld) this.browsers.release();
      if (accountHeld) st.lock.release();
      st.pending--;
      throw err;
    }

    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        // Think-time after an END too, so a finishing request does not open the gate for an
        // immediate follow-up on the same account.
        st.nextStartAt = Math.max(st.nextStartAt, this.now() + cfg.minIntervalMs);
        this.browsers.release();
        st.lock.release();
        st.pending--;
      },
    };
  }

  private assertNoChallenge(): void {
    const remaining = this.challengeRemainingMs();
    if (remaining > 0) {
      throw new GeminiWebGateError(
        "upstream_challenge",
        `Gemini Web is paused: Google served an unusual-traffic challenge ` +
          `(${this.challengeReason ?? "429"}). Requests are refused for ` +
          `${Math.ceil(remaining / 60_000)} more minute(s) so the session is not hammered while ` +
          `flagged. Solve the captcha at gemini.google.com from the same network, or wait.`,
        remaining
      );
    }
  }

  private account(key: string): AccountState {
    let st = this.accounts.get(key);
    if (st) return st;
    if (this.accounts.size >= MAX_ACCOUNT_STATES) {
      // Idle states only hold a timestamp; drop the oldest idle one.
      for (const [k, v] of this.accounts) {
        if (v.pending === 0) {
          this.accounts.delete(k);
          break;
        }
      }
    }
    st = {
      lock: new FifoSemaphore(this.config.maxConcurrentPerAccount),
      pending: 0,
      nextStartAt: 0,
    };
    this.accounts.set(key, st);
    return st;
  }
}

/** Stable, non-reversible per-account key: the __Secure-1PSID value if present, else the cookie. */
export function geminiWebAccountKey(cookieHeader: string): string {
  const match = /(?:^|;\s*)__Secure-1PSID=([^;]+)/.exec(cookieHeader);
  const material = match?.[1]?.trim() || cookieHeader.trim();
  return createHash("sha256").update(material).digest("hex").slice(0, 16);
}

// ─── Process singleton ──────────────────────────────────────────────────────

let singleton: GeminiWebGate | null = null;

export function getGeminiWebGate(): GeminiWebGate {
  if (!singleton) singleton = new GeminiWebGate();
  return singleton;
}

/** Test hook: swap (or clear, with null) the process-wide gate. */
export function __setGeminiWebGateForTests(gate: GeminiWebGate | null): void {
  singleton = gate;
}
