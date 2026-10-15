import test from "node:test";
import assert from "node:assert/strict";

const {
  applyCookieUpdates,
  collectCookieUpdates,
  parseCookieHeader,
  parseSetCookie,
  resolveGeminiWebCookieHeader,
  rotateGeminiWebCookies,
  serializeCookieHeader,
  toPlaywrightCookies,
  GEMINI_WEB_ROTATE_URL,
} = await import("../../open-sse/services/geminiWebSession.ts");

// ─── Cookie jar ─────────────────────────────────────────────────────────────

test("parseCookieHeader drops attributes and empty pairs, keeps order", () => {
  const pairs = parseCookieHeader(
    "__Secure-1PSID=aaa; Path=/; __Secure-1PSIDTS=bbb; Secure; HttpOnly; empty=; SIDCC=ccc"
  );
  assert.deepEqual(pairs, [
    { name: "__Secure-1PSID", value: "aaa" },
    { name: "__Secure-1PSIDTS", value: "bbb" },
    { name: "SIDCC", value: "ccc" },
  ]);
  assert.equal(serializeCookieHeader(pairs), "__Secure-1PSID=aaa; __Secure-1PSIDTS=bbb; SIDCC=ccc");
});

test("applyCookieUpdates replaces in place, appends new, removes null, and reports real changes", () => {
  const start = "A=1; __Secure-1PSIDTS=old; B=2";
  const result = applyCookieUpdates(start, [
    { name: "__Secure-1PSIDTS", value: "new" },
    { name: "SIDCC", value: "fresh" },
    { name: "B", value: null },
  ]);
  assert.equal(result.header, "A=1; __Secure-1PSIDTS=new; SIDCC=fresh");
  assert.deepEqual(result.changed.sort(), ["B", "SIDCC", "__Secure-1PSIDTS"]);
});

test("applyCookieUpdates is a no-op for identical values and for removing an absent cookie", () => {
  const start = "A=1; B=2";
  const result = applyCookieUpdates(start, [
    { name: "A", value: "1" },
    { name: "GONE", value: null },
  ]);
  assert.equal(result.header, start);
  assert.deepEqual(result.changed, []);
});

test("parseSetCookie reads value and treats Max-Age<=0 / past Expires / empty as removal", () => {
  const now = Date.parse("2026-10-14T20:00:00Z");
  assert.deepEqual(
    parseSetCookie(
      "__Secure-1PSIDTS=sidts-abc; expires=Fri, 14 Oct 2027 20:00:00 GMT; path=/; domain=.google.com; Secure; HttpOnly",
      now
    ),
    { name: "__Secure-1PSIDTS", value: "sidts-abc" }
  );
  assert.deepEqual(parseSetCookie("SIDCC=x; Max-Age=0; Path=/", now), {
    name: "SIDCC",
    value: null,
  });
  assert.deepEqual(parseSetCookie("SIDCC=x; Expires=Thu, 01 Jan 1970 00:00:00 GMT", now), {
    name: "SIDCC",
    value: null,
  });
  assert.deepEqual(parseSetCookie("SIDCC=; Path=/", now), { name: "SIDCC", value: null });
  assert.equal(parseSetCookie("garbage", now), null);
});

test("resolveGeminiWebCookieHeader keeps the executor's precedence", () => {
  assert.equal(resolveGeminiWebCookieHeader({ apiKey: "raw" }), "__Secure-1PSID=raw");
  assert.equal(resolveGeminiWebCookieHeader({ apiKey: "A=1; B=2" }), "A=1; B=2");
  assert.equal(resolveGeminiWebCookieHeader({ providerSpecificData: { cookie: "A=1" } }), "A=1");
  assert.equal(
    resolveGeminiWebCookieHeader({
      providerSpecificData: { "__Secure-1PSID": "p", "__Secure-1PSIDTS": "t" },
    }),
    "__Secure-1PSID=p; __Secure-1PSIDTS=t"
  );
  assert.equal(resolveGeminiWebCookieHeader({ providerSpecificData: ["x"] }), "");
});

// ─── Playwright mapping ─────────────────────────────────────────────────────

test("toPlaywrightCookies puts __Host- cookies in by URL (a Domain makes Chromium reject the batch)", () => {
  const mapped = toPlaywrightCookies([
    { name: "__Secure-1PSID", value: "a" },
    { name: "__Host-1PLSID", value: "b" },
    { name: "__Host-GAPS", value: "c" },
  ]);
  assert.deepEqual(mapped[0], {
    name: "__Secure-1PSID",
    value: "a",
    domain: ".google.com",
    path: "/",
    secure: true,
  });
  for (const host of mapped.slice(1)) {
    assert.equal(host.url, "https://accounts.google.com/");
    assert.equal(host.secure, true);
    assert.equal("domain" in host, false, `${host.name} must not carry a domain`);
    assert.equal("path" in host, false, `${host.name} must not carry a path`);
  }
});

test("collectCookieUpdates returns rotations and ignores unrelated new cookies", () => {
  const sent = [
    { name: "__Secure-1PSID", value: "psid" },
    { name: "__Secure-1PSIDTS", value: "ts-old" },
    { name: "SID", value: "sid" },
  ];
  const updates = collectCookieUpdates(sent, [
    { name: "__Secure-1PSID", value: "psid", domain: ".google.com" },
    { name: "__Secure-1PSIDTS", value: "ts-new", domain: ".google.com" }, // rotated
    { name: "__Secure-3PSIDTS", value: "ts3-new", domain: ".google.com" }, // absent but rotating family
    { name: "SIDCC", value: "cc", domain: ".google.com" }, // rotating family, absent
    { name: "NID", value: "tracking", domain: ".google.com" }, // unrelated new -> ignored
    { name: "SID", value: "other-site", domain: ".example.com" }, // not google -> ignored
    { name: "__Secure-1PSIDCC", value: "", domain: ".google.com" }, // empty -> ignored
  ]);
  assert.deepEqual(
    updates.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    [
      { name: "SIDCC", value: "cc" },
      { name: "__Secure-1PSIDTS", value: "ts-new" },
      { name: "__Secure-3PSIDTS", value: "ts3-new" },
    ]
  );
});

// ─── RotateCookies ──────────────────────────────────────────────────────────

function responseWithCookies(status: number, setCookies: string[] = []): Response {
  const headers = new Headers();
  for (const line of setCookies) headers.append("set-cookie", line);
  return new Response("[]", { status, headers });
}

test("rotateGeminiWebCookies posts the full header and merges Set-Cookie", async () => {
  let seen: { url: string; init: RequestInit } | null = null;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen = { url, init };
    return responseWithCookies(200, [
      "__Secure-1PSIDTS=ts-new; Path=/; Domain=.google.com; Secure; HttpOnly",
      "__Secure-3PSIDTS=ts3-new; Path=/; Domain=.google.com; Secure; HttpOnly",
      "SIDCC=cc-new; Path=/; Domain=.google.com",
    ]);
  }) as typeof fetch;

  const header = "__Secure-1PSID=psid; __Secure-1PSIDTS=ts-old; __Host-1PLSID=host; LSID=l";
  const outcome = await rotateGeminiWebCookies(header, { fetchImpl });

  assert.equal(outcome.status, "rotated");
  if (outcome.status !== "rotated") return;
  assert.equal(
    outcome.cookie,
    "__Secure-1PSID=psid; __Secure-1PSIDTS=ts-new; __Host-1PLSID=host; LSID=l; " +
      "__Secure-3PSIDTS=ts3-new; SIDCC=cc-new"
  );
  assert.deepEqual(outcome.changed.sort(), ["SIDCC", "__Secure-1PSIDTS", "__Secure-3PSIDTS"]);

  assert.equal(seen!.url, GEMINI_WEB_ROTATE_URL);
  assert.equal(seen!.init.method, "POST");
  assert.equal((seen!.init.headers as Record<string, string>).Cookie, header);
  assert.equal(seen!.init.redirect, "manual");
});

test("rotateGeminiWebCookies: 200 without new cookies is 'unchanged'", async () => {
  const outcome = await rotateGeminiWebCookies("A=1", {
    fetchImpl: (async () => responseWithCookies(200)) as typeof fetch,
  });
  assert.deepEqual(outcome, { status: "unchanged", cookie: "A=1" });
});

test("rotateGeminiWebCookies: 401 means the session is dead", async () => {
  const outcome = await rotateGeminiWebCookies("A=1", {
    fetchImpl: (async () => responseWithCookies(401)) as typeof fetch,
  });
  assert.deepEqual(outcome, { status: "unauthorized", httpStatus: 401 });
});

test("rotateGeminiWebCookies: 429, redirects and transport failures are retryable errors", async () => {
  for (const status of [429, 500, 302]) {
    const outcome = await rotateGeminiWebCookies("A=1", {
      fetchImpl: (async () => responseWithCookies(status)) as typeof fetch,
    });
    assert.equal(outcome.status, "error", `HTTP ${status}`);
  }
  const failure = await rotateGeminiWebCookies("A=1", {
    fetchImpl: (async () => {
      throw new Error("socket hang up");
    }) as typeof fetch,
  });
  assert.deepEqual(failure, { status: "error", message: "socket hang up" });
});
