/**
 * Tailnet device directory: tailnet IP -> device name.
 *
 * The OmniRoute container has no access to tailscaled, so the host writes
 * `tailscale status --json` into the data dir on a timer (see the omniroute-ops
 * skill: crontab on the Pi -> /opt/omniroute/data/tailnet-devices.json). This
 * module parses that file, caching by mtime. Tailnet IPs are stable per node in
 * Headscale, so usage rows keep only the IP and are labelled at read time — a
 * rename in Headscale relabels history instead of freezing an old name.
 *
 * Missing/unreadable file = empty directory: reports fall back to the raw IP and
 * a device binding can still be written as an IP.
 */
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "@/lib/db/core";

export const TAILNET_DEVICES_FILE = "tailnet-devices.json";

export interface TailnetDevice {
  name: string;
  os: string | null;
  ips: string[];
}

type StatusNode = {
  HostName?: unknown;
  DNSName?: unknown;
  OS?: unknown;
  TailscaleIPs?: unknown;
};

/** Short device name: the first DNS label ("marcos.hs.internal." -> "marcos"). */
function nodeName(node: StatusNode): string | null {
  const dns = typeof node.DNSName === "string" ? node.DNSName.split(".")[0] : "";
  if (dns) return dns;
  return typeof node.HostName === "string" && node.HostName ? node.HostName : null;
}

/** Parse `tailscale status --json` into devices. Pure, for tests. */
export function parseTailscaleStatus(status: unknown): TailnetDevice[] {
  const root = (status && typeof status === "object" ? status : {}) as {
    Self?: StatusNode;
    Peer?: Record<string, StatusNode>;
  };
  const nodes: StatusNode[] = [
    ...(root.Self ? [root.Self] : []),
    ...Object.values(root.Peer && typeof root.Peer === "object" ? root.Peer : {}),
  ];
  const devices: TailnetDevice[] = [];
  for (const node of nodes) {
    const name = nodeName(node);
    const ips = Array.isArray(node.TailscaleIPs)
      ? node.TailscaleIPs.filter((ip): ip is string => typeof ip === "string")
      : [];
    if (!name || ips.length === 0) continue;
    devices.push({ name, os: typeof node.OS === "string" ? node.OS : null, ips });
  }
  return devices;
}

let cache: { mtimeMs: number; byIp: Map<string, TailnetDevice> } | null = null;

/** IP -> device, from the host-written status file (cached by mtime). */
export function getTailnetDevicesByIp(dataDir: string = DATA_DIR): Map<string, TailnetDevice> {
  const file = path.join(dataDir, TAILNET_DEVICES_FILE);
  try {
    const { mtimeMs } = fs.statSync(file);
    if (cache && cache.mtimeMs === mtimeMs) return cache.byIp;
    const byIp = new Map<string, TailnetDevice>();
    for (const device of parseTailscaleStatus(JSON.parse(fs.readFileSync(file, "utf8")))) {
      for (const ip of device.ips) byIp.set(ip, device);
    }
    cache = { mtimeMs, byIp };
    return byIp;
  } catch {
    return new Map();
  }
}

/**
 * Whether `clientIp` satisfies a key's device binding. An entry matches when it
 * is the IP itself or the device's name (case-insensitive). An unknown caller
 * never matches — a bound key fails closed.
 */
export function isClientAllowedByDeviceList(
  clientIp: string | null,
  allowlist: readonly string[],
  devicesByIp: Map<string, TailnetDevice>
): boolean {
  if (!clientIp) return false;
  const deviceName = devicesByIp.get(clientIp)?.name.toLowerCase() ?? null;
  return allowlist.some((entry) => {
    const wanted = entry.trim().toLowerCase();
    return wanted === clientIp.toLowerCase() || (deviceName !== null && wanted === deviceName);
  });
}

/** "marcos (100.64.0.14)", or the bare IP when the device is unknown. */
export function describeClient(
  clientIp: string | null,
  devicesByIp: Map<string, TailnetDevice>
): string {
  if (!clientIp) return "an unidentified client";
  const name = devicesByIp.get(clientIp)?.name;
  return name ? `${name} (${clientIp})` : clientIp;
}
