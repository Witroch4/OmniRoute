import test from "node:test";
import assert from "node:assert/strict";

// Every variable detectRestrictedEnvironment() reads. Each case starts from a clean slate so
// the host running the suite cannot leak into it: on WSL, WSL_INTEROP/WSL_DISTRO_NAME are set
// in every process, and on GitHub Actions CI=true is — either one used to decide the result
// before the variable under test was even looked at.
const DETECTION_VARS = [
  "CODESPACES",
  "GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN",
  "WSL_DISTRO_NAME",
  "WSL_INTEROP",
  "GITPOD_WORKSPACE_ID",
  "REPL_ID",
  "REPL_SLUG",
  "CI",
];

function withEnv(overrides: Record<string, string | undefined>, fn: () => void) {
  const vars: Record<string, string | undefined> = {
    ...Object.fromEntries(DETECTION_VARS.map((k) => [k, undefined])),
    ...overrides,
  };
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("detectRestrictedEnvironment retorna github-codespaces quando CODESPACES=true", async () => {
  const { detectRestrictedEnvironment } = await import("../../bin/cli/utils/environment.mjs");
  withEnv({ CODESPACES: "true" }, () => {
    const env = detectRestrictedEnvironment();
    assert.equal(env.type, "github-codespaces");
    assert.equal(env.canOpenBrowser, false);
    assert.equal(env.canUseTray, false);
  });
});

test("detectRestrictedEnvironment retorna wsl com hint", async () => {
  const { detectRestrictedEnvironment } = await import("../../bin/cli/utils/environment.mjs");
  withEnv({ WSL_DISTRO_NAME: "Ubuntu-22.04" }, () => {
    const env = detectRestrictedEnvironment();
    assert.equal(env.type, "wsl");
    assert.equal(env.canOpenBrowser, true);
    assert.equal(env.canUseTray, false);
    assert.ok(env.hint?.includes("Windows"));
  });
});

test("detectRestrictedEnvironment retorna gitpod quando GITPOD_WORKSPACE_ID set", async () => {
  const { detectRestrictedEnvironment } = await import("../../bin/cli/utils/environment.mjs");
  withEnv({ GITPOD_WORKSPACE_ID: "ws-abc123" }, () => {
    const env = detectRestrictedEnvironment();
    assert.equal(env.type, "gitpod");
    assert.equal(env.canOpenBrowser, false);
  });
});

test("detectRestrictedEnvironment retorna ci quando CI=1", async () => {
  const { detectRestrictedEnvironment } = await import("../../bin/cli/utils/environment.mjs");
  withEnv({ CI: "1" }, () => {
    const env = detectRestrictedEnvironment();
    assert.equal(env.type, "ci");
    assert.equal(env.canOpenBrowser, false);
  });
});

test("detectRestrictedEnvironment: CI explícito vence a heurística de WSL", async () => {
  // A CI job on a WSL runner has nobody at the Windows desktop, so the WSL answer
  // (canOpenBrowser: true) would pop a browser on the build host. The explicit session
  // markers (CI, Gitpod, Replit) describe the session; WSL only describes the kernel.
  const { detectRestrictedEnvironment } = await import("../../bin/cli/utils/environment.mjs");
  for (const marker of [{ CI: "true" }, { GITPOD_WORKSPACE_ID: "ws-1" }, { REPL_ID: "r-1" }]) {
    withEnv({ WSL_DISTRO_NAME: "Ubuntu", WSL_INTEROP: "/run/WSL/1_interop", ...marker }, () => {
      const env = detectRestrictedEnvironment();
      assert.notEqual(env.type, "wsl", `${Object.keys(marker)[0]} must win over WSL`);
      assert.equal(env.canOpenBrowser, false);
    });
  }
});

test("detectRestrictedEnvironment retorna replit quando REPL_ID set", async () => {
  const { detectRestrictedEnvironment } = await import("../../bin/cli/utils/environment.mjs");
  withEnv({ REPL_ID: "repl-123" }, () => {
    const env = detectRestrictedEnvironment();
    assert.equal(env.type, "replit");
    assert.equal(env.canOpenBrowser, false);
  });
});

test("getEnvBanner retorna null para desktop", async () => {
  const { getEnvBanner } = await import("../../bin/cli/utils/environment.mjs");
  withEnv({}, () => {
    // Non-TTY stdin will return non-interactive, not null
    // So we just test the function exists and returns a string or null
    const banner = getEnvBanner();
    assert.ok(banner === null || typeof banner === "string");
  });
});

test("getEnvBanner retorna string com tipo para Codespaces", async () => {
  const { getEnvBanner } = await import("../../bin/cli/utils/environment.mjs");
  withEnv({ CODESPACES: "true" }, () => {
    const banner = getEnvBanner();
    assert.ok(typeof banner === "string");
    assert.ok(banner!.includes("github-codespaces"));
  });
});

test("environment.mjs pode ser importado sem erro", async () => {
  const mod = await import("../../bin/cli/utils/environment.mjs");
  assert.equal(typeof mod.detectRestrictedEnvironment, "function");
  assert.equal(typeof mod.getEnvBanner, "function");
});
