import { NextResponse } from "next/server";

import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { getDbInstance } from "@/lib/db/core";
import { getTailnetDevicesByIp } from "@/lib/tailnet/tailnetDevices";
import { priceUsageRows, type UsageCostRow } from "@/lib/usage/apiKeyUsageLimits";
import * as log from "@/sse/utils/logger";

/**
 * GET /api/usage/devices?since=ISO&until=ISO&apiKeyId=ID
 *
 * Who consumed from which machine: usage per API key x client tailnet IP, with
 * the device name resolved from the tailnet directory and the real USD cost
 * priced like the per-key quota. Rows without a client IP (history before
 * migration 171, or a caller that bypassed the edge) are grouped as null.
 * Default window: the last 7 days.
 */
export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const url = new URL(request.url);
    const until = url.searchParams.get("until") || new Date().toISOString();
    const since =
      url.searchParams.get("since") ||
      new Date(Date.parse(until) - 7 * 24 * 60 * 60 * 1000).toISOString();
    const apiKeyId = url.searchParams.get("apiKeyId");
    if (Number.isNaN(Date.parse(since)) || Number.isNaN(Date.parse(until))) {
      return NextResponse.json({ error: "since/until must be ISO timestamps" }, { status: 400 });
    }

    const rows = getDbInstance()
      .prepare(
        `SELECT api_key_id as apiKeyId, MAX(api_key_name) as apiKeyName, client_ip as clientIp,
                LOWER(provider) as provider, LOWER(model) as model,
                COALESCE(NULLIF(service_tier, ''), 'standard') as serviceTier,
                COUNT(*) as requests, SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as succeeded,
                COALESCE(SUM(tokens_input), 0) as promptTokens,
                COALESCE(SUM(tokens_output), 0) as completionTokens,
                COALESCE(SUM(tokens_cache_read), 0) as cacheReadTokens,
                COALESCE(SUM(tokens_cache_creation), 0) as cacheCreationTokens,
                COALESCE(SUM(tokens_reasoning), 0) as reasoningTokens,
                MAX(timestamp) as lastSeen
           FROM usage_history
          WHERE timestamp >= @since AND timestamp < @until
            AND api_key_id IS NOT NULL
            AND (@apiKeyId IS NULL OR api_key_id = @apiKeyId)
          GROUP BY api_key_id, client_ip, LOWER(provider), LOWER(model), serviceTier`
      )
      .all({ since, until, apiKeyId }) as Array<
      UsageCostRow & {
        apiKeyId: string;
        apiKeyName: string | null;
        clientIp: string | null;
        requests: number;
        succeeded: number;
        lastSeen: string;
      }
    >;

    const devicesByIp = getTailnetDevicesByIp();
    const groups = new Map<
      string,
      {
        apiKeyId: string;
        apiKeyName: string | null;
        clientIp: string | null;
        device: string | null;
        requests: number;
        succeeded: number;
        tokensIn: number;
        tokensOut: number;
        lastSeen: string;
        costRows: UsageCostRow[];
      }
    >();
    for (const row of rows) {
      const key = `${row.apiKeyId}|${row.clientIp ?? ""}`;
      let group = groups.get(key);
      if (!group) {
        group = {
          apiKeyId: row.apiKeyId,
          apiKeyName: row.apiKeyName,
          clientIp: row.clientIp,
          device: row.clientIp ? (devicesByIp.get(row.clientIp)?.name ?? null) : null,
          requests: 0,
          succeeded: 0,
          tokensIn: 0,
          tokensOut: 0,
          lastSeen: row.lastSeen,
          costRows: [],
        };
        groups.set(key, group);
      }
      group.requests += Number(row.requests) || 0;
      group.succeeded += Number(row.succeeded) || 0;
      group.tokensIn += Number(row.promptTokens) || 0;
      group.tokensOut += Number(row.completionTokens) || 0;
      if (row.lastSeen > group.lastSeen) group.lastSeen = row.lastSeen;
      group.costRows.push(row);
    }

    const result = [];
    for (const { costRows, ...group } of groups.values()) {
      const costUsd = await priceUsageRows(costRows);
      result.push({ ...group, costUsd: Number(costUsd.toFixed(4)) });
    }
    result.sort((a, b) => b.costUsd - a.costUsd);

    return NextResponse.json({ since, until, rows: result });
  } catch (error) {
    log.error("usage", "Error building per-device usage report", error);
    return NextResponse.json({ error: "Failed to build device usage report" }, { status: 500 });
  }
}
