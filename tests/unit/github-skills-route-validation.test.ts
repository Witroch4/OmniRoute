// t06 route-validation: POST /api/github-skills must validate its body with a
// Zod schema (Hard Rule #7) instead of blind request.json() destructuring.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// requireManagementAuth (added to this route in upstream v3.8.47, after this
// test was written in v3.8.45) resolves `isAuthRequired` against the SQLite
// database at DATA_DIR, which defaults to ~/.omniroute — the developer's real
// OmniRoute install. With a password configured there the route answered 401
// before ever running the Zod validation this file is about. Isolate the data
// directory so auth is not required and the validation path is what is tested.
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-ghskills-"));
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
const ORIGINAL_API_KEY_SECRET = process.env.API_KEY_SECRET;
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET ?? "github-skills-route-test-secret";
delete process.env.INITIAL_PASSWORD;

const { POST } = await import("../../src/app/api/github-skills/route.ts");

test.after(() => {
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = ORIGINAL_DATA_DIR;
  if (ORIGINAL_API_KEY_SECRET === undefined) delete process.env.API_KEY_SECRET;
  else process.env.API_KEY_SECRET = ORIGINAL_API_KEY_SECRET;
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

function post(body: unknown): Request {
  return new Request("http://localhost/api/github-skills", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("POST github-skills: missing repoName → 400", async () => {
  const res = await POST(post({ targets: ["hermes"] }) as never);
  assert.equal(res.status, 400);
});

test("POST github-skills: non-array targets → 400 (was silently .map-crashing before Zod)", async () => {
  const res = await POST(post({ repoName: "a/b", targets: "hermes" }) as never);
  assert.equal(res.status, 400);
});

test("POST github-skills: valid body → 200 with per-target results and defaults applied", async () => {
  const res = await POST(post({ repoName: "owner/skill-repo" }) as never);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { skillName: string; results: { target: string }[] };
  assert.equal(body.skillName, "skill-repo");
  assert.equal(body.results[0].target, "hermes");
});

test("POST github-skills: 400 error body does not leak stack traces", async () => {
  const res = await POST(post({}) as never);
  const text = await res.text();
  assert.ok(!text.includes("at /"), "stack trace leaked");
});
