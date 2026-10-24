import assert from "node:assert/strict";
import test from "node:test";

import { AGY_CONFIG, ANTIGRAVITY_CONFIG } from "../../src/lib/oauth/constants/oauth.ts";
import { agy } from "../../src/lib/oauth/providers/agy.ts";
import { antigravity } from "../../src/lib/oauth/providers/antigravity.ts";
import {
  clearAntigravityVersionCaches,
  seedAntigravityCliVersionCache,
  seedAntigravityIdeVersionCache,
} from "../../open-sse/services/antigravityVersion.ts";
import { antigravityCliUserAgent } from "../../open-sse/config/antigravityCliClient.ts";

// Fork: both OAuth providers present the official `agy` CLI identity captured on the wire
// (open-sse/config/antigravityCliClient.ts) — Go oauth2 client on the token endpoint, the
// CLI's four headers on Cloud Code. Upstream's IDE Node identity for `antigravity` (#8013)
// does not apply; "ide" is only a legacy per-connection opt-in.

const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  clearAntigravityVersionCaches();
});

test("token exchange presents the CLI's Go oauth2 client for both providers", async () => {
  seedAntigravityIdeVersionCache("2.1.1");
  seedAntigravityCliVersionCache("1.1.1");
  const headers: Headers[] = [];

  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    headers.push(new Headers(init?.headers));
    return Response.json({ access_token: "token", refresh_token: "refresh", expires_in: 3600 });
  }) as typeof fetch;

  await antigravity.exchangeToken(ANTIGRAVITY_CONFIG, "ide-code", "http://localhost/callback");
  await agy.exchangeToken(AGY_CONFIG, "cli-code", "http://localhost/callback");

  for (const h of headers) {
    assert.equal(h.get("User-Agent"), "Go-http-client/1.1");
    assert.equal(h.get("Content-Type"), "application/x-www-form-urlencoded");
    assert.equal(h.get("Accept-Encoding"), "gzip");
  }
});

for (const [name, provider] of [
  ["antigravity", antigravity],
  ["agy", agy],
] as const) {
  test(`${name} post-exchange and onboarding use the official CLI identity`, async () => {
    seedAntigravityIdeVersionCache("2.1.1");
    seedAntigravityCliVersionCache("1.1.1");
    const cloudCodeHeaders: Headers[] = [];
    let userInfoHeaders: Headers | null = null;

    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      const urlString = String(url);
      if (urlString.includes("userinfo")) {
        userInfoHeaders = new Headers(init?.headers);
        return Response.json({ email: `${name}@example.com` });
      }
      if (urlString.includes("loadCodeAssist")) {
        cloudCodeHeaders.push(new Headers(init?.headers));
        return Response.json({
          cloudaicompanionProject: `${name}-project`,
          allowedTiers: [{ id: "legacy-tier", isDefault: true }],
        });
      }
      if (urlString.includes("onboardUser")) {
        cloudCodeHeaders.push(new Headers(init?.headers));
        return Response.json({ done: true });
      }
      return Response.json({});
    }) as typeof fetch;

    const extra = await provider.postExchange({ access_token: `${name}-token` } as never);
    const mapped = provider.mapTokens({ access_token: `${name}-token` } as never, extra);
    await new Promise((resolve) => setTimeout(resolve, 25));

    assert.equal(userInfoHeaders?.get("User-Agent"), "Go-http-client/1.1");
    assert.ok(cloudCodeHeaders.length >= 2);
    for (const headers of cloudCodeHeaders) {
      assert.equal(headers.get("User-Agent"), antigravityCliUserAgent());
      assert.equal(headers.get("Accept-Encoding"), "gzip");
      assert.equal(headers.get("X-Goog-Api-Client"), null);
      assert.equal(headers.get("Client-Metadata"), null);
    }
    assert.equal(mapped.providerSpecificData.clientProfile, "cli");
  });
}
