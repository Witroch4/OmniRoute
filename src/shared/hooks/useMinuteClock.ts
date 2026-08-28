"use client";

import { useSyncExternalStore } from "react";

/**
 * The wall clock, read the way React wants an external mutable source read.
 *
 * A countdown needs "now", but `Date.now()` in a render body is impure — React may
 * re-render at any moment and get a different answer — and seeding it with a setState
 * inside an effect trips the cascading-render rule. useSyncExternalStore is the
 * sanctioned shape: one cached snapshot, mutated only by the subscription.
 *
 * One shared minute-resolution timer for every subscriber, started on the first
 * subscribe and stopped when the last one leaves, so an unmounted dashboard leaves no
 * interval behind.
 */

let cachedNow = Date.now();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

const TICK_MS = 60_000;

function publish() {
  cachedNow = Date.now();
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);

  // Refresh on subscribe: the module-level seed can be arbitrarily stale if the bundle
  // was loaded long before this component mounted (a tab left open overnight).
  // Subscribing happens in an effect, so touching the clock here is legal.
  publish();

  if (timer === null) timer = setInterval(publish, TICK_MS);

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

function getSnapshot(): number {
  return cachedNow;
}

/** Current epoch milliseconds, re-rendering subscribers about once a minute. */
export function useMinuteClock(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
