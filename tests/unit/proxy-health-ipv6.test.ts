import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import {
  isProxyReachable,
  invalidateProxyHealth,
  __setProxyHealthTcpCheckForTesting,
} from "../../src/lib/proxyHealth";

describe("proxyHealth IPv6-literal reachability", () => {
  const probed: string[] = [];

  afterEach(() => {
    __setProxyHealthTcpCheckForTesting(null);
    for (const url of probed.splice(0)) invalidateProxyHealth(url);
  });

  // The behaviour this module owns: `new URL("http://[::1]:3128").hostname` is "[::1]",
  // and a bracketed host handed to net.createConnection is looked up as a DNS name and
  // fails. The host must reach the TCP check de-bracketed. Asserted on the exact
  // (host, port) the probe receives, so no real IPv6 socket is needed.
  it("hands the TCP probe a de-bracketed IPv6 literal (no socket needed)", async () => {
    const calls: Array<{ host: string; port: number }> = [];
    __setProxyHealthTcpCheckForTesting(async (host, port) => {
      calls.push({ host, port });
      return true;
    });

    const cases = [
      { url: "http://[::1]:3128", host: "::1", port: 3128 },
      { url: "socks5://user:secret@[2001:db8::1]:1080", host: "2001:db8::1", port: 1080 },
      // Fork: upstream #14157/#14184 made a portless http proxy probe its scheme default (80),
      // not 8080 — the WHATWG URL parser drops `:80`, so "no port" means 80.
      { url: "http://[fe80::1]", host: "fe80::1", port: 80 },
      { url: "http://127.0.0.1:8081", host: "127.0.0.1", port: 8081 },
    ];
    for (const { url } of cases) {
      probed.push(url);
      invalidateProxyHealth(url);
      assert.equal(await isProxyReachable(url, 1000), true, url);
    }

    assert.deepEqual(
      calls,
      cases.map(({ host, port }) => ({ host, port }))
    );
  });

  // End to end through the real TCP check. This one genuinely needs an IPv6 loopback
  // socket, so it is skipped (with the reason) on hosts that cannot bind ::1 instead of
  // passing silently.
  it("connects to a real IPv6-literal proxy through the default TCP check", async (t) => {
    const server = net.createServer((socket) => socket.destroy());
    const listening = await new Promise<boolean>((resolve) => {
      server.once("error", () => resolve(false));
      server.listen(0, "::1", () => resolve(true));
    });
    if (!listening) {
      t.skip("IPv6 loopback (::1) cannot be bound on this host");
      return;
    }
    try {
      const { port } = server.address() as net.AddressInfo;
      const url = `http://[::1]:${port}`;
      probed.push(url);
      invalidateProxyHealth(url);
      // The probe resolves on connect; the budget only bounds a starved process, so it
      // is the module's default rather than a tight 1s that flaked under parallel load.
      assert.equal(await isProxyReachable(url), true, "should connect to ::1 after de-bracketing");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
