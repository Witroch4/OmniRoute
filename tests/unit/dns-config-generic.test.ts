/**
 * Unit tests: parameterized DNS helpers (addDNSEntries / removeDNSEntries)
 *
 * The hosts-file path and the privileged runners are swapped through
 * `__setDnsConfigDepsForTests`, so these tests never read or write /etc/hosts
 * and never invoke sudo. (Before that seam existed this file ran the real
 * `sudo -S tee -a /etc/hosts`: it failed wherever sudo needs a password and,
 * on hosts with passwordless sudo such as CI runners, appended real entries to
 * the system hosts file.)
 *
 * The fake runner records every call and then performs what sudo would have
 * run, minus the elevation, against a temp hosts file — so add/remove are
 * exercised end to end, including the inline remove script.
 *
 * Hard Rule #13 assertion: commands use argv array form, no interpolation.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The isolateDataDir test setup sets OMNIROUTE_SKIP_DNS_WRITE=1, which makes the
// writers no-ops. This file swaps in a temp hosts file and fake runners, so it is safe
// to exercise the real write paths; the guard itself is covered by mitm-dnsConfig.test.ts.
const previousSkipDnsWrite = process.env.OMNIROUTE_SKIP_DNS_WRITE;
delete process.env.OMNIROUTE_SKIP_DNS_WRITE;

const dnsModule = await import("../../src/mitm/dns/dnsConfig.ts");
const {
  addDNSEntries,
  removeDNSEntries,
  addDNSEntry,
  removeDNSEntry,
  checkDNSEntry,
  resolveHostsForAgent,
  __setDnsConfigDepsForTests,
} = dnsModule;
const { ALL_TARGETS } = await import("../../src/mitm/targets/index.ts");

const ANTIGRAVITY_HOSTS = [
  "daily-cloudcode-pa.googleapis.com",
  "cloudcode-pa.googleapis.com",
  "daily-cloudcode-pa.sandbox.googleapis.com",
  "autopush-cloudcode-pa.sandbox.googleapis.com",
];
const BASE_HOSTS = "127.0.0.1 localhost\n::1 localhost\n";

// The write paths below exercise the POSIX `sudo -S` branch; on Windows the module
// takes the elevated-PowerShell branch instead (IS_WIN is fixed at module load).
const POSIX_ONLY =
  process.platform === "win32" ? "Windows uses the elevated PowerShell branch" : false;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dns-test-"));
const hostsFile = path.join(tmpDir, "hosts");

interface ExecCall {
  command: string;
  args: string[];
  password: string;
  stdin: string;
}
const execCalls: ExecCall[] = [];
let execFailure: Error | null = null;

async function fakeExecWithPassword(
  command: string,
  args: string[],
  password: string,
  stdinAfterPassword = ""
): Promise<string> {
  execCalls.push({ command, args: [...args], password, stdin: stdinAfterPassword });
  if (execFailure) throw execFailure;
  assert.equal(command, "sudo");
  assert.equal(args[0], "-S");
  assert.ok(!args.includes("/etc/hosts"), "the real hosts file must never be targeted");
  const [bin, ...rest] = args.slice(1);
  if (bin === "tee") {
    assert.deepEqual(rest, ["-a", hostsFile]);
    fs.appendFileSync(hostsFile, stdinAfterPassword);
    return "";
  }
  return execFileSync(bin, rest, { encoding: "utf8" });
}

async function fakeElevatedPowerShell(): Promise<string> {
  throw new Error("elevated PowerShell must not run in this test");
}

const restoreDeps = __setDnsConfigDepsForTests({
  hostsFile,
  execWithPassword: fakeExecWithPassword,
  elevatedPowerShell: fakeElevatedPowerShell,
});

function resetHosts(content = BASE_HOSTS) {
  fs.writeFileSync(hostsFile, content);
  execCalls.length = 0;
  execFailure = null;
}

function readHosts(): string {
  return fs.readFileSync(hostsFile, "utf8");
}

function entriesFor(hosts: string[]): string {
  return hosts.map((h) => `127.0.0.1 ${h}\n::1 ${h}\n`).join("");
}

function hostsOf(agentId: string): string[] {
  const target = ALL_TARGETS.find((t) => t.id === agentId);
  assert.ok(target, `${agentId} target must exist in ALL_TARGETS`);
  return target.hosts;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("checkDNSEntry reads the configured hosts file", () => {
  resetHosts();
  assert.equal(checkDNSEntry(), false);
  resetHosts(BASE_HOSTS + entriesFor(ANTIGRAVITY_HOSTS));
  assert.equal(checkDNSEntry(), true);
});

test("addDNSEntries: exported function exists and accepts string[] + password", async () => {
  resetHosts();
  assert.equal(typeof addDNSEntries, "function");
  // Calling with empty list must resolve (no-op)
  await assert.doesNotReject(addDNSEntries([], "any-password"));
  assert.equal(execCalls.length, 0);
});

test("removeDNSEntries: exported function exists and accepts string[] + password", async () => {
  resetHosts();
  assert.equal(typeof removeDNSEntries, "function");
  // Calling with empty list must resolve (no-op)
  await assert.doesNotReject(removeDNSEntries([], "any-password"));
  assert.equal(execCalls.length, 0);
});

test("addDNSEntry (legacy) is a function that delegates for Antigravity hosts", () => {
  assert.equal(typeof addDNSEntry, "function");
});

test(
  "addDNSEntry with agentId resolves agent-specific hosts from ALL_TARGETS",
  { skip: POSIX_ONLY },
  async () => {
    resetHosts();
    const cursorHosts = hostsOf("cursor");
    await addDNSEntry("fake-sudo", "cursor");
    assert.equal(execCalls.length, 1, "all missing entries are batched into one tee call");
    assert.equal(execCalls[0].password, "fake-sudo");
    assert.equal(execCalls[0].stdin, entriesFor(cursorHosts));
    assert.equal(readHosts(), BASE_HOSTS + entriesFor(cursorHosts));
  }
);

test(
  "addDNSEntry without agentId falls back to Antigravity hosts (backward compat)",
  { skip: POSIX_ONLY },
  async () => {
    resetHosts();
    await addDNSEntry("fake-sudo");
    assert.equal(execCalls.length, 1);
    assert.equal(execCalls[0].stdin, entriesFor(ANTIGRAVITY_HOSTS));
    assert.equal(checkDNSEntry(), true, "the legacy check sees what the legacy add wrote");
  }
);

test(
  "addDNSEntry with unknown agentId falls back to Antigravity hosts",
  { skip: POSIX_ONLY },
  async () => {
    resetHosts();
    await addDNSEntry("fake-sudo", "__nonexistent_agent__");
    assert.equal(execCalls.length, 1);
    assert.equal(execCalls[0].stdin, entriesFor(ANTIGRAVITY_HOSTS));
  }
);

test("removeDNSEntry (legacy) is a function that delegates for Antigravity hosts", () => {
  assert.equal(typeof removeDNSEntry, "function");
});

test(
  "removeDNSEntry with agentId resolves agent-specific hosts from ALL_TARGETS",
  { skip: POSIX_ONLY },
  async () => {
    const copilotHosts = hostsOf("copilot");
    resetHosts(BASE_HOSTS + entriesFor(copilotHosts) + entriesFor(ANTIGRAVITY_HOSTS));
    await removeDNSEntry("fake-sudo", "copilot");
    assert.equal(execCalls.length, copilotHosts.length, "one remove call per present host");
    assert.equal(readHosts(), BASE_HOSTS + entriesFor(ANTIGRAVITY_HOSTS));
  }
);

test("resolveHostsForAgent returns Antigravity hosts when agentId is undefined", () => {
  // Verify ALL_TARGETS exists and cursor target has expected hosts
  const cursorTarget = ALL_TARGETS.find((t) => t.id === "cursor");
  assert.ok(cursorTarget, "cursor target must exist in ALL_TARGETS");
  assert.ok(
    cursorTarget.hosts.includes("api2.cursor.sh"),
    "cursor target must include api2.cursor.sh"
  );
  // Codex target
  const codexTarget = ALL_TARGETS.find((t) => t.id === "codex");
  assert.ok(codexTarget, "codex target must exist in ALL_TARGETS");
  assert.ok(codexTarget.hosts.includes("chatgpt.com"), "codex target must include chatgpt.com");
});

test("addDNSEntries batches missing entries with no-op on empty list", async () => {
  resetHosts();
  // Empty list must resolve immediately (no exec, no error)
  await assert.doesNotReject(addDNSEntries([], "fake-sudo"));
  assert.equal(execCalls.length, 0);
});

test("addDNSEntries: skips hosts already in the hosts file (idempotency)", async () => {
  resetHosts();
  // Both the 127.0.0.1 and ::1 lines for localhost are present: nothing to write.
  await addDNSEntries(["localhost"], "fake-sudo-password");
  assert.equal(execCalls.length, 0, "no privileged call when every entry already exists");
  assert.equal(readHosts(), BASE_HOSTS);
});

test(
  "addDNSEntries: writes only the missing family of a half-present host",
  { skip: POSIX_ONLY },
  async () => {
    resetHosts(BASE_HOSTS + "127.0.0.1 api2.cursor.sh\n");
    await addDNSEntries(["api2.cursor.sh"], "fake-sudo-password");
    assert.equal(execCalls.length, 1);
    assert.equal(execCalls[0].stdin, "::1 api2.cursor.sh\n");
  }
);

test("removeDNSEntries: skips hosts NOT in the hosts file (idempotency)", async () => {
  resetHosts();
  // A host that does not exist in the hosts file.
  const fakeHost = `omniroute-test-nonexistent-${Date.now()}.invalid`;
  await assert.doesNotReject(
    removeDNSEntries([fakeHost], "fake-sudo-password"),
    "removeDNSEntries must not throw when host is not present"
  );
  assert.equal(execCalls.length, 0);
});

test("add/removeDNSEntries propagate a failed privileged call", { skip: POSIX_ONLY }, async () => {
  resetHosts(BASE_HOSTS + entriesFor(["api2.cursor.sh"]));
  execFailure = new Error("Command failed with code 1");
  await assert.rejects(addDNSEntries(["chatgpt.com"], "wrong-password"), /code 1/);
  await assert.rejects(removeDNSEntries(["api2.cursor.sh"], "wrong-password"), /code 1/);
  assert.equal(readHosts(), BASE_HOSTS + entriesFor(["api2.cursor.sh"]), "file left untouched");
});

test(
  "addDNSEntries: calls exec with array-form args (Hard Rule #13 pattern)",
  { skip: POSIX_ONLY },
  async () => {
    // The tee invocation must use array form: the hosts-file path is its own argv
    // element, never template-interpolated into a shell string.
    resetHosts();
    await addDNSEntries(["chatgpt.com"], "fake-sudo");
    assert.equal(execCalls[0].command, "sudo");
    assert.deepEqual(execCalls[0].args, ["-S", "tee", "-a", hostsFile]);

    // The remove invocation must pass the hosts-file path and the hostname as
    // process.argv of the inline script, not string-interpolated into its body.
    execCalls.length = 0;
    await removeDNSEntries(["chatgpt.com"], "fake-sudo");
    assert.equal(execCalls.length, 1);
    const [sudoFlag, nodeBin, evalFlag, script, fileArg, hostArg] = execCalls[0].args;
    assert.deepEqual([sudoFlag, nodeBin, evalFlag], ["-S", process.execPath, "-e"]);
    assert.equal(fileArg, hostsFile);
    assert.equal(hostArg, "chatgpt.com");
    assert.ok(!script.includes("chatgpt.com"), "hostname must not be interpolated into the script");
    assert.ok(!script.includes(hostsFile), "path must not be interpolated into the script");
    assert.equal(readHosts(), BASE_HOSTS);
  }
);

test(
  "addDNSEntries: entry passed as stdin data, not shell-interpolated",
  { skip: POSIX_ONLY },
  async () => {
    // A hostname carrying shell metacharacters must travel only through stdin.
    resetHosts();
    const hostile = "evil.example;rm -rf $HOME";
    await addDNSEntries([hostile], "fake-sudo");
    assert.equal(execCalls.length, 1);
    assert.ok(
      execCalls[0].args.every((arg) => !arg.includes("evil.example")),
      "entry content must never reach the argv array"
    );
    assert.equal(execCalls[0].stdin, `127.0.0.1 ${hostile}\n::1 ${hostile}\n`);
  }
);

test(
  "addDNSEntries: generates both IPv4 and IPv6 lines per host",
  { skip: POSIX_ONLY },
  async () => {
    resetHosts();
    await addDNSEntries(["chatgpt.com", "api2.cursor.sh"], "fake-sudo");
    const written = execCalls[0].stdin.split("\n").filter(Boolean);
    assert.deepEqual(written, [
      "127.0.0.1 chatgpt.com",
      "::1 chatgpt.com",
      "127.0.0.1 api2.cursor.sh",
      "::1 api2.cursor.sh",
    ]);
  }
);

test("resolveHostsForAgent returns the agent's hosts and falls back to Antigravity", () => {
  assert.deepEqual(resolveHostsForAgent(), ANTIGRAVITY_HOSTS);
  assert.deepEqual(resolveHostsForAgent("__nonexistent_agent__"), ANTIGRAVITY_HOSTS);
  assert.ok(
    hostsOf("cursor").includes("api2.cursor.sh"),
    "cursor target must include api2.cursor.sh"
  );
  assert.deepEqual(resolveHostsForAgent("cursor"), hostsOf("cursor"));
  assert.ok(hostsOf("codex").includes("chatgpt.com"), "codex target must include chatgpt.com");
});

test(
  "explicit per-call command dependencies win over the injected defaults",
  { skip: POSIX_ONLY },
  async () => {
    resetHosts();
    const perCall: string[] = [];
    await addDNSEntry("fake-sudo", "cursor", {
      execFileWithPassword: async (_command, args, _password, stdin = "") => {
        perCall.push(args.join(" "));
        fs.appendFileSync(hostsFile, stdin);
        return "";
      },
    });
    assert.equal(perCall.length, 1);
    assert.equal(execCalls.length, 0, "the injected default runner must not be used");
    assert.equal(readHosts(), BASE_HOSTS + entriesFor(hostsOf("cursor")));
  }
);

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
test.after(() => {
  restoreDeps();
  if (previousSkipDnsWrite === undefined) delete process.env.OMNIROUTE_SKIP_DNS_WRITE;
  else process.env.OMNIROUTE_SKIP_DNS_WRITE = previousSkipDnsWrite;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // best effort
  }
});
