/**
 * Tests for Kiro multi-account isolation (issue #2328).
 *
 * Each OmniRoute connection must own its own OIDC client registration
 * (clientId + clientSecret) so that refreshing or re-authenticating one
 * account does not invalidate another account's refresh token.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// validateImportToken tries a Builder ID refresh FIRST, using credentials read
// from `os.homedir()/.aws/sso/cache`. On a developer machine that has ever
// signed into Kiro/AWS that cache exists, so the service returned
// authMethod "builder-id" with the real cached clientId and never reached the
// mocked /client/register — these tests passed only on a machine with no AWS
// SSO cache. Worse, the suite was reading real credential material out of the
// operator's home directory. Point HOME at an empty directory so the Builder ID
// branch finds nothing and the social-auth path under test is the one exercised.
const ISOLATED_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-kiro-home-"));
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
process.env.HOME = ISOLATED_HOME;
process.env.USERPROFILE = ISOLATED_HOME;

test.after(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_USERPROFILE === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = ORIGINAL_USERPROFILE;
  fs.rmSync(ISOLATED_HOME, { recursive: true, force: true });
});

// Dynamic import, deliberately: a static `import` is hoisted ABOVE the env
// assignments above, so the isolation would only work by accident (the service
// happens to call homedir() per-request rather than at module scope). Loading
// the module after HOME is set makes the guarantee explicit instead of luck.
const { KiroService } = await import("../../src/lib/oauth/services/kiro.ts");

// ── helpers ───────────────────────────────────────────────────────────────────

function withMockedFetch(impl: typeof fetch, fn: () => Promise<void>) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Build a fetch mock that handles:
 *  - /token  → returns a minimal token refresh response
 *  - /client/register → returns the given registration pair
 */
function buildFetchMock(registration: {
  clientId: string;
  clientSecret: string;
  clientSecretExpiresAt?: number;
}) {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/client/register")) {
      return jsonResponse(registration);
    }
    // Treat any other URL as a social-auth/refresh endpoint
    return jsonResponse({
      accessToken: "at-mock",
      refreshToken: "rt-next-mock",
      expiresIn: 3600,
    });
  }) as typeof fetch;
}

// A valid-looking Kiro refresh token (must start with "aorAAAAAG")
const VALID_REFRESH_TOKEN = "aorAAAAAG-mock-refresh-token-for-tests";

// ── tests ─────────────────────────────────────────────────────────────────────

test("validateImportToken registers a client and returns clientId + clientSecret", async () => {
  const service = new KiroService();
  const reg = {
    clientId: "test-client-id",
    clientSecret: "test-client-secret",
    clientSecretExpiresAt: 9999999999,
  };

  await withMockedFetch(buildFetchMock(reg), async () => {
    const result = await service.validateImportToken(VALID_REFRESH_TOKEN);
    assert.equal(result.clientId, reg.clientId, "clientId should be returned");
    assert.equal(result.clientSecret, reg.clientSecret, "clientSecret should be returned");
    assert.equal(
      result.clientSecretExpiresAt,
      reg.clientSecretExpiresAt,
      "clientSecretExpiresAt should be returned"
    );
    assert.equal(result.authMethod, "imported");
    assert.equal(result.accessToken, "at-mock");
  });
});

test("validateImportToken succeeds without clientId when registerClient fails", async () => {
  const service = new KiroService();
  let callCount = 0;

  await withMockedFetch(
    async (input) => {
      const url = String(input);
      callCount++;
      if (url.endsWith("/client/register")) {
        return new Response("Service Unavailable", { status: 503 });
      }
      return jsonResponse({
        accessToken: "at-degraded",
        refreshToken: "rt-degraded",
        expiresIn: 3600,
      });
    },
    async () => {
      // Should not throw even though registerClient fails
      const result = await service.validateImportToken(VALID_REFRESH_TOKEN);
      assert.equal(
        result.accessToken,
        "at-degraded",
        "import should succeed with a degraded token"
      );
      assert.equal(result.authMethod, "imported");
      // clientId must not be set — the connection degrades to shared social-auth path
      assert.equal(result.clientId, undefined, "clientId should be absent on degraded import");
      assert.equal(
        result.clientSecret,
        undefined,
        "clientSecret should be absent on degraded import"
      );
    }
  );

  assert.ok(callCount >= 1, "fetch should have been called at least once");
});

test("validateImportToken throws when token format is invalid", async () => {
  const service = new KiroService();
  await assert.rejects(
    () => service.validateImportToken("invalid-token-does-not-start-correctly"),
    /Invalid token format/
  );
});

test("two validateImportToken calls return different clientIds when registerClient returns distinct pairs", async () => {
  const service = new KiroService();
  let registrationIndex = 0;
  const registrations = [
    { clientId: "client-alpha", clientSecret: "secret-alpha" },
    { clientId: "client-beta", clientSecret: "secret-beta" },
  ];

  const mockFetch: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/client/register")) {
      return jsonResponse(registrations[registrationIndex++] ?? registrations[0]);
    }
    return jsonResponse({ accessToken: "at", refreshToken: "rt", expiresIn: 3600 });
  };

  await withMockedFetch(mockFetch, async () => {
    const result1 = await service.validateImportToken(VALID_REFRESH_TOKEN);
    const result2 = await service.validateImportToken(VALID_REFRESH_TOKEN);

    assert.notEqual(
      result1.clientId,
      result2.clientId,
      "each import call should receive a distinct clientId for session isolation"
    );
    assert.equal(result1.clientId, "client-alpha");
    assert.equal(result2.clientId, "client-beta");
  });
});

test("registerClient uses the provided region in the OIDC endpoint URL", async () => {
  const service = new KiroService();
  const calls: string[] = [];

  await withMockedFetch(
    async (input) => {
      calls.push(String(input));
      return jsonResponse({ clientId: "cid", clientSecret: "csec" });
    },
    async () => {
      await service.registerClient("ap-southeast-1");
    }
  );

  assert.ok(
    calls.some((url) => url.includes("ap-southeast-1")),
    "registerClient should call the OIDC endpoint for the specified region"
  );
});
