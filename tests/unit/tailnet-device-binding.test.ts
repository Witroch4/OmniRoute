/**
 * Per-device usage attribution and API-key device binding (migration 171).
 * The caller's tailnet IP arrives in X-Forwarded-For / X-Real-IP, rewritten by
 * the OmniRoute edge (nginx) from the PROXY-protocol address.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-tailnet-binding-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "tailnet-binding-secret";

const coreDb = await import("../../src/lib/db/core.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const usageHistory = await import("../../src/lib/usage/usageHistory.ts");
const rateLimiter = await import("../../src/shared/utils/rateLimiter.ts");
const tailnet = await import("../../src/lib/tailnet/tailnetDevices.ts");
const { extractClientIpOrNull } = await import("../../open-sse/services/deviceTracker.ts");

rateLimiter.setRateLimiterTestMode(true);

const STATUS = {
  Self: {
    HostName: "casa-exit",
    DNSName: "casa-exit.hs.internal.",
    OS: "linux",
    TailscaleIPs: ["100.64.0.1"],
  },
  Peer: {
    a: {
      HostName: "marcos",
      DNSName: "marcos.hs.internal.",
      OS: "windows",
      TailscaleIPs: ["100.64.0.14", "fd7a:115c:a1e0::e"],
    },
    b: {
      HostName: "opmusv5",
      DNSName: "opmusv5.hs.internal.",
      OS: "windows",
      TailscaleIPs: ["100.64.0.6"],
    },
  },
};
fs.writeFileSync(path.join(TEST_DATA_DIR, tailnet.TAILNET_DEVICES_FILE), JSON.stringify(STATUS));

async function loadPolicy(label: string) {
  const modulePath = path.join(process.cwd(), "src/shared/utils/apiKeyPolicy.ts");
  return import(`${pathToFileURL(modulePath).href}?case=${label}-${Date.now()}`);
}

function requestFrom(key: string, ip?: string) {
  const headers: Record<string, string> = { Authorization: `Bearer ${key}` };
  if (ip) {
    headers["X-Forwarded-For"] = ip;
    headers["X-Real-IP"] = ip;
  }
  return new Request("http://localhost/v1/messages", { method: "POST", headers });
}

test.after(() => {
  apiKeysDb.resetApiKeyState();
  coreDb.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("tailscale status maps every tailnet IP to its short device name", () => {
  const byIp = tailnet.getTailnetDevicesByIp(TEST_DATA_DIR);
  assert.equal(byIp.get("100.64.0.14")?.name, "marcos");
  assert.equal(byIp.get("fd7a:115c:a1e0::e")?.name, "marcos");
  assert.equal(byIp.get("100.64.0.1")?.name, "casa-exit");
  assert.equal(tailnet.describeClient("100.64.0.6", byIp), "opmusv5 (100.64.0.6)");
  assert.equal(tailnet.describeClient("100.64.0.99", byIp), "100.64.0.99");
  assert.equal(tailnet.describeClient(null, byIp), "an unidentified client");
});

test("a missing directory file degrades to an empty map", () => {
  assert.equal(tailnet.getTailnetDevicesByIp(path.join(TEST_DATA_DIR, "nope")).size, 0);
});

test("only a literal IP is accepted as the client IP", () => {
  assert.equal(extractClientIpOrNull({ "x-forwarded-for": "100.64.0.14" }), "100.64.0.14");
  assert.equal(extractClientIpOrNull({ "x-forwarded-for": "unknown" }), null);
  assert.equal(extractClientIpOrNull({}), null);
  assert.equal(extractClientIpOrNull(null), null);
});

test("device list matches by IP or by device name, fails closed on unknown", () => {
  const byIp = tailnet.getTailnetDevicesByIp(TEST_DATA_DIR);
  assert.equal(tailnet.isClientAllowedByDeviceList("100.64.0.14", ["100.64.0.14"], byIp), true);
  assert.equal(tailnet.isClientAllowedByDeviceList("100.64.0.14", ["Marcos"], byIp), true);
  assert.equal(tailnet.isClientAllowedByDeviceList("100.64.0.6", ["marcos"], byIp), false);
  assert.equal(tailnet.isClientAllowedByDeviceList(null, ["marcos"], byIp), false);
});

test("usage rows persist the caller's client IP", async () => {
  await usageHistory.saveRequestUsage({
    provider: "claude",
    model: "claude-sonnet-5-5",
    tokens: { input: 10, output: 5 },
    apiKeyId: "k1",
    apiKeyName: "marcos cc",
    clientIp: "100.64.0.14",
    timestamp: new Date().toISOString(),
  });
  const row = coreDb
    .getDbInstance()
    .prepare("SELECT client_ip FROM usage_history WHERE api_key_id = 'k1'")
    .get() as { client_ip: string | null };
  assert.equal(row.client_ip, "100.64.0.14");
});

test("a bound key is served only from its device", async () => {
  const created = await apiKeysDb.createApiKey("marcos cc", "machine-bind");
  await apiKeysDb.updateApiKeyPermissions(created.id, { ipAllowlist: ["marcos"] });
  const policy = await loadPolicy("bound");

  const fromMarcos = await policy.enforceApiKeyPolicy(
    requestFrom(created.key, "100.64.0.14"),
    "claude-sonnet-5"
  );
  assert.equal(fromMarcos.rejection, null);

  const fromOther = await policy.enforceApiKeyPolicy(
    requestFrom(created.key, "100.64.0.6"),
    "claude-sonnet-5"
  );
  assert.equal(fromOther.rejection?.status, 403);
  const message = ((await fromOther.rejection.json()) as { error: { message: string } }).error
    .message;
  assert.match(message, /bound to: marcos/);
  assert.match(message, /opmusv5 \(100\.64\.0\.6\)/);

  const unknown = await policy.enforceApiKeyPolicy(requestFrom(created.key), "claude-sonnet-5");
  assert.equal(unknown.rejection?.status, 403);
});

test("an unbound key is not affected, and clearing the list unbinds", async () => {
  const created = await apiKeysDb.createApiKey("free key", "machine-free");
  const policy = await loadPolicy("unbound");
  assert.equal(
    (await policy.enforceApiKeyPolicy(requestFrom(created.key, "100.64.0.6"), "x")).rejection,
    null
  );

  await apiKeysDb.updateApiKeyPermissions(created.id, { ipAllowlist: ["100.64.0.14"] });
  await apiKeysDb.updateApiKeyPermissions(created.id, { ipAllowlist: [] });
  const policy2 = await loadPolicy("cleared");
  assert.equal(
    (await policy2.enforceApiKeyPolicy(requestFrom(created.key, "100.64.0.6"), "x")).rejection,
    null
  );
});
