import assert from "node:assert/strict";
import test from "node:test";

import {
  ANTIGRAVITY_CLI_FALLBACK_VERSION,
  ANTIGRAVITY_IDE_FALLBACK_VERSION,
  ANTIGRAVITY_VERSION_CACHE_TTL_MS,
  clearAntigravityVersionCaches,
  getCachedAntigravityCliVersion,
  getCachedAntigravityIdeVersion,
  resolveAntigravityCliVersion,
  resolveAntigravityIdeVersion,
  seedAntigravityCliVersionCache,
  seedAntigravityIdeVersionCache,
} from "../../open-sse/services/antigravityVersion.ts";
import {
  ANTIGRAVITY_CLI_DEFAULT_VERSION,
  getAntigravityCliBuild,
} from "../../open-sse/config/antigravityCliClient.ts";

// Fork: the CLI version is pinned together with its build changelist in
// antigravityCliClient.ts (the official agy wire capture), so it is never resolved from a
// release feed — a feed bump would put a new version next to a stale `cl=`. Only the legacy
// IDE profile resolves its version from the updater feed.

const originalDateNow = Date.now;

test.afterEach(() => {
  Date.now = originalDateNow;
  clearAntigravityVersionCaches();
});

test("IDE and CLI start with independent captured fallback versions", () => {
  assert.equal(getCachedAntigravityIdeVersion(), ANTIGRAVITY_IDE_FALLBACK_VERSION);
  assert.equal(getCachedAntigravityCliVersion(), ANTIGRAVITY_CLI_FALLBACK_VERSION);
  assert.equal(ANTIGRAVITY_IDE_FALLBACK_VERSION, "2.5.5");
  assert.equal(ANTIGRAVITY_CLI_FALLBACK_VERSION, ANTIGRAVITY_CLI_DEFAULT_VERSION);
  assert.equal(getCachedAntigravityCliVersion(), getAntigravityCliBuild().version);
});

test("IDE resolver reads the official updater feed and caches only the IDE version", async () => {
  const urls: string[] = [];
  const fetchMock = async (url: string | URL | Request) => {
    urls.push(String(url));
    return new Response(JSON.stringify([{ version: "2.6.0", execution_id: "ide-release" }]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  assert.equal(await resolveAntigravityIdeVersion(fetchMock as typeof fetch), "2.6.0");
  assert.equal(await resolveAntigravityIdeVersion(fetchMock as typeof fetch), "2.6.0");
  assert.equal(urls.length, 1);
  assert.equal(
    urls[0],
    "https://antigravity-auto-updater-974169037036.us-central1.run.app/releases"
  );
  assert.equal(getCachedAntigravityIdeVersion(), "2.6.0");
  assert.equal(getCachedAntigravityCliVersion(), ANTIGRAVITY_CLI_FALLBACK_VERSION);
});

test("IDE resolver selects the newest feed entry and never falls below its version floor", async () => {
  const mixedFeedFetch = async () =>
    new Response(
      JSON.stringify([
        { version: "2.0.0" },
        { version: "2.8.0" },
        { version: "2.6.0" },
        { version: "invalid" },
      ]),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );

  assert.equal(await resolveAntigravityIdeVersion(mixedFeedFetch as typeof fetch), "2.8.0");

  clearAntigravityVersionCaches();
  const staleFeedFetch = async () =>
    new Response(JSON.stringify([{ version: "2.0.0" }, { version: "1.23.2" }]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  assert.equal(
    await resolveAntigravityIdeVersion(staleFeedFetch as typeof fetch),
    ANTIGRAVITY_IDE_FALLBACK_VERSION
  );
  assert.equal(getCachedAntigravityIdeVersion(), ANTIGRAVITY_IDE_FALLBACK_VERSION);
});

test("IDE resolver keeps a newer cached version when a later feed response is older", async () => {
  let now = 1_000;
  Date.now = () => now;
  seedAntigravityIdeVersionCache("2.9.0", now);
  now += ANTIGRAVITY_VERSION_CACHE_TTL_MS + 1;

  const olderFeedFetch = async () =>
    new Response(JSON.stringify([{ version: "2.8.0" }]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  assert.equal(await resolveAntigravityIdeVersion(olderFeedFetch as typeof fetch), "2.9.0");
  assert.equal(getCachedAntigravityIdeVersion(), "2.9.0");
});

test("CLI resolver is pinned: no release-feed lookup, seeds never reach the wire", async () => {
  const urls: string[] = [];
  const fetchMock = async (url: string | URL | Request) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ tag_name: "v9.9.9", name: "9.9.9" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  assert.equal(
    await resolveAntigravityCliVersion(fetchMock as typeof fetch),
    getAntigravityCliBuild().version
  );
  assert.equal(urls.length, 0, "the CLI version must not be fetched from a release feed");
  seedAntigravityCliVersionCache("1.4.0");
  assert.equal(getCachedAntigravityCliVersion(), getAntigravityCliBuild().version);
  assert.equal(getCachedAntigravityIdeVersion(), "2.5.5");
});

test("IDE and CLI TTL refreshes are independent", async () => {
  let now = 1_000;
  Date.now = () => now;
  seedAntigravityCliVersionCache("1.3.4", now);

  const firstFetch = async () =>
    new Response(JSON.stringify([{ version: "2.6.0" }]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  const secondFetch = async () =>
    new Response(JSON.stringify([{ version: "2.7.0" }]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  assert.equal(await resolveAntigravityIdeVersion(firstFetch as typeof fetch), "2.6.0");
  now += ANTIGRAVITY_VERSION_CACHE_TTL_MS + 1;
  assert.equal(await resolveAntigravityIdeVersion(secondFetch as typeof fetch), "2.7.0");
  assert.equal(getCachedAntigravityCliVersion(), ANTIGRAVITY_CLI_FALLBACK_VERSION);
});

test("each resolver falls back only to its own last known good version", async () => {
  const failingFetch = async () => {
    throw new Error("network down");
  };

  assert.equal(
    await resolveAntigravityIdeVersion(failingFetch as typeof fetch),
    ANTIGRAVITY_IDE_FALLBACK_VERSION
  );
  assert.equal(
    await resolveAntigravityCliVersion(failingFetch as typeof fetch),
    ANTIGRAVITY_CLI_FALLBACK_VERSION
  );

  seedAntigravityIdeVersionCache("2.8.0", 0);
  seedAntigravityCliVersionCache("1.4.0", 0);
  assert.equal(await resolveAntigravityIdeVersion(failingFetch as typeof fetch), "2.8.0");
  // The CLI stays on its pinned build whatever was seeded.
  assert.equal(
    await resolveAntigravityCliVersion(failingFetch as typeof fetch),
    ANTIGRAVITY_CLI_FALLBACK_VERSION
  );
});

test("concurrent requests coalesce within each product without crossing products", async () => {
  let ideCalls = 0;
  let cliCalls = 0;
  let releaseIde: (() => void) | undefined;
  let releaseCli: (() => void) | undefined;
  const ideGate = new Promise<void>((resolve) => {
    releaseIde = resolve;
  });
  const cliGate = new Promise<void>((resolve) => {
    releaseCli = resolve;
  });

  const ideFetch = async () => {
    ideCalls += 1;
    await ideGate;
    return new Response(JSON.stringify([{ version: "2.9.0" }]), { status: 200 });
  };
  const cliFetch = async () => {
    cliCalls += 1;
    await cliGate;
    return new Response(JSON.stringify({ tag_name: "1.4.0" }), { status: 200 });
  };

  const ideOne = resolveAntigravityIdeVersion(ideFetch as typeof fetch);
  const ideTwo = resolveAntigravityIdeVersion(ideFetch as typeof fetch);
  const cliOne = resolveAntigravityCliVersion(cliFetch as typeof fetch);
  const cliTwo = resolveAntigravityCliVersion(cliFetch as typeof fetch);
  releaseIde?.();
  releaseCli?.();

  assert.deepEqual(await Promise.all([ideOne, ideTwo]), ["2.9.0", "2.9.0"]);
  assert.deepEqual(await Promise.all([cliOne, cliTwo]), [
    ANTIGRAVITY_CLI_FALLBACK_VERSION,
    ANTIGRAVITY_CLI_FALLBACK_VERSION,
  ]);
  assert.equal(ideCalls, 1);
  assert.equal(cliCalls, 0, "the pinned CLI version is never fetched");
});
