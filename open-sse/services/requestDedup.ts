/**
 * Request Deduplication Service
 *
 * Deduplicates **concurrent** identical requests to the same upstream.
 * Inspired by ClawRouter's dedup.ts (BlockRunAI / github.com/BlockRunAI/ClawRouter).
 *
 * IMPORTANT: In-memory only — does NOT persist across restarts and does NOT
 * work across multiple process instances (no cross-instance dedup).
 */

import { createHash } from "node:crypto";

const MAX_INFLIGHT = 1000;

export interface DedupConfig {
  enabled: boolean;
  maxTemperatureForDedup: number;
  timeoutMs: number;
}

export const DEFAULT_DEDUP_CONFIG: DedupConfig = {
  enabled: true,
  maxTemperatureForDedup: 0.1,
  timeoutMs: 60_000,
};

export interface DedupResult<T> {
  result: T;
  wasDeduplicated: boolean;
  hash: string;
}

const inflight = new Map<string, Promise<unknown>>();

/**
 * Compute a deterministic hash for a request body.
 * Hash the full translated body: Responses uses input/instructions, Anthropic
 * uses messages/system, and Gemini uses contents/generationConfig. A whitelist
 * of OpenAI Chat fields silently merged unrelated batches after translation.
 * False cache misses are preferable to returning another request's completion.
 */
export function computeRequestHash(requestBody: unknown): string {
  const body = requestBody as Record<string, unknown>;
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

/** Determine whether a request should be deduplicated */
export function shouldDeduplicate(
  requestBody: unknown,
  config: DedupConfig = DEFAULT_DEDUP_CONFIG
): boolean {
  if (!config.enabled) return false;
  const body = requestBody as Record<string, unknown>;
  if (body.stream === true) return false;
  const temperature = typeof body.temperature === "number" ? body.temperature : 1.0;
  if (temperature > config.maxTemperatureForDedup) return false;
  return true;
}

/**
 * Execute a request with deduplication.
 * Concurrent identical requests share one upstream call.
 */
export async function deduplicate<T>(
  hash: string,
  fn: () => Promise<T>,
  config: DedupConfig = DEFAULT_DEDUP_CONFIG
): Promise<DedupResult<T>> {
  if (!config.enabled) {
    return { result: await fn(), wasDeduplicated: false, hash };
  }

  const existing = inflight.get(hash);
  if (existing) {
    const result = (await existing) as T;
    return { result, wasDeduplicated: true, hash };
  }

  if (inflight.size >= MAX_INFLIGHT) {
    const oldestKey = inflight.keys().next().value;
    if (oldestKey !== undefined) inflight.delete(oldestKey);
  }

  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const sharedPromise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  inflight.set(hash, sharedPromise as Promise<unknown>);

  const timer = setTimeout(() => {
    if (inflight.get(hash) === sharedPromise) inflight.delete(hash);
  }, config.timeoutMs);

  try {
    const result = await fn();
    resolve(result);
    return { result, wasDeduplicated: false, hash };
  } catch (err) {
    reject(err);
    throw err;
  } finally {
    clearTimeout(timer);
    if (inflight.get(hash) === sharedPromise) inflight.delete(hash);
  }
}

export function getInflightCount(): number {
  return inflight.size;
}
export function getInflightHashes(): string[] {
  return [...inflight.keys()];
}
export function clearInflight(): void {
  inflight.clear();
}
