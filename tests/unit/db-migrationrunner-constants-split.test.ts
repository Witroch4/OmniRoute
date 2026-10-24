/**
 * Characterization / snapshot test: migrationRunner.ts god-file decomposition.
 *
 * The static migration-compatibility data tables were extracted verbatim from
 * src/lib/db/migrationRunner.ts into the pure-data leaf
 * src/lib/db/migrationRunner/constants.ts (no imports, no DB, no behaviour).
 *
 * These tables drive the reconciliation / dedup / already-applied detection
 * paths in runMigrations(). The existing db-migration-runner.test.ts proves the
 * BEHAVIOUR is unchanged; this test PINS THE DATA so a bad move (a dropped row,
 * a transposed version, a corrupted sentinel) is caught immediately — the data
 * is the thing the move could silently break.
 *
 * Pure value assertions — no DB handle is opened.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  RENAMED_MIGRATION_COMPATIBILITY,
  LEGACY_VERSION_SLOT_MIGRATIONS,
  SUPERSEDED_DUPLICATE_MIGRATIONS,
  PHYSICAL_SCHEMA_SENTINELS,
  INITIAL_SCHEMA_SENTINELS,
  OPTIONAL_FTS5_MIGRATION_VERSIONS,
} from "../../src/lib/db/migrationRunner/constants.ts";

// ── small tables — full snapshot ─────────────────────────────────────────────

describe("migrationRunner/constants — exact small-table snapshots", () => {
  it("LEGACY_VERSION_SLOT_MIGRATIONS is the 12-entry list, in order", () => {
    assert.deepEqual(
      LEGACY_VERSION_SLOT_MIGRATIONS.map((m) => `${m.version}:${m.name}`),
      [
        "028:evals_tables",
        "029:webhooks_templates",
        "030:mcp_scopes_api_keys",
        "031:api_keys_expires",
        "032:detailed_logs_warnings",
        "033:provider_connections_block_extra_usage",
        "033:add_batch_id_to_call_logs",
        "046:remove_status_from_files",
        "051:remove_status_from_files",
        // fork rows from v3.8.29–v3.8.36 still sitting on upstream's 100/104/105 slots
        "100:api_key_usage_limits",
        "104:provider_quota_reset_events",
        "105:usage_command_show_usd",
      ]
    );
  });

  it("SUPERSEDED_DUPLICATE_MIGRATIONS is the single 041→050 session_account_affinity entry", () => {
    assert.deepEqual(SUPERSEDED_DUPLICATE_MIGRATIONS, [
      {
        version: "041",
        name: "session_account_affinity",
        supersededByVersion: "050",
        supersededByName: "session_account_affinity",
      },
    ]);
  });

  it("INITIAL_SCHEMA_SENTINELS pins the three baseline tables", () => {
    assert.deepEqual(INITIAL_SCHEMA_SENTINELS, ["provider_connections", "combos", "call_logs"]);
  });

  it("OPTIONAL_FTS5_MIGRATION_VERSIONS includes dependent FTS migrations", () => {
    assert.ok(OPTIONAL_FTS5_MIGRATION_VERSIONS instanceof Set);
    assert.deepEqual([...OPTIONAL_FTS5_MIGRATION_VERSIONS].sort(), ["022", "023", "178", "203"]);
  });
});

// ── large tables — count + shape + spot-checks (corruption guard) ─────────────

describe("migrationRunner/constants — large-table integrity", () => {
  it("RENAMED_MIGRATION_COMPATIBILITY has 48 well-formed entries", () => {
    // 33 upstream renames + 15 fork entries moving the fork migrations into the reserved
    // 900–907 block (7 from the original 123–129 slots, 8 from 164–171).
    assert.equal(RENAMED_MIGRATION_COMPATIBILITY.length, 48);
    for (const e of RENAMED_MIGRATION_COMPATIBILITY) {
      assert.equal(typeof e.fromVersion, "string");
      assert.equal(typeof e.fromName, "string");
      assert.equal(typeof e.toVersion, "string");
      assert.equal(typeof e.toName, "string");
    }
  });

  it("RENAMED_MIGRATION_COMPATIBILITY still carries the fork → 900–907 block", () => {
    // Tripwire: a future upstream merge that resolves constants.ts by taking "theirs"
    // would drop these and make the runner skip upstream's 123–129 and 164–171 on every
    // production database that recorded the fork migrations there. Fail loudly instead.
    const forkRenames = RENAMED_MIGRATION_COMPATIBILITY.filter(
      (e) => Number(e.toVersion) >= 900 && Number(e.toVersion) <= 907
    ).map((e) => `${e.fromVersion}_${e.fromName} -> ${e.toVersion}_${e.toName}`);

    assert.deepEqual(forkRenames, [
      "123_api_key_min_spend_guarantee -> 900_api_key_min_spend_guarantee",
      "164_api_key_min_spend_guarantee -> 900_api_key_min_spend_guarantee",
      "124_quota_snapshots_window_index -> 901_quota_snapshots_window_index",
      "165_quota_snapshots_window_index -> 901_quota_snapshots_window_index",
      "125_api_key_model_budget_rules -> 902_api_key_model_budget_rules",
      "166_api_key_model_budget_rules -> 902_api_key_model_budget_rules",
      "126_usage_history_billed_model -> 903_usage_history_billed_model",
      "167_usage_history_billed_model -> 903_usage_history_billed_model",
      "127_domain_cost_history_billed_cost -> 904_domain_cost_history_billed_cost",
      "168_domain_cost_history_billed_cost -> 904_domain_cost_history_billed_cost",
      "128_api_key_model_family_multipliers -> 905_api_key_model_family_multipliers",
      "169_api_key_model_family_multipliers -> 905_api_key_model_family_multipliers",
      "129_api_key_renewal_cycle -> 906_api_key_renewal_cycle",
      "170_api_key_renewal_cycle -> 906_api_key_renewal_cycle",
      "171_usage_history_client_ip -> 907_usage_history_client_ip",
    ]);
  });

  it("RENAMED_MIGRATION_COMPATIBILITY spot-checks the boundary renames", () => {
    const first = RENAMED_MIGRATION_COMPATIBILITY[0];
    assert.deepEqual(first, {
      fromVersion: "022",
      fromName: "call_logs_summary_storage",
      toVersion: "025",
      toName: "call_logs_summary_storage",
    });
    // both manifest_routing collisions (052→059 and 056→059) must survive
    const manifest = RENAMED_MIGRATION_COMPATIBILITY.filter((e) => e.toName === "manifest_routing");
    assert.deepEqual(manifest.map((e) => e.fromVersion).sort(), ["052", "056"]);
    const devin = RENAMED_MIGRATION_COMPATIBILITY.filter(
      (e) => e.toName === "windsurf_to_devin_desktop"
    );
    assert.deepEqual(
      devin.map((e) => e.fromVersion),
      [
        "123",
        "124",
        "125",
        "126",
        "127",
        "128",
        "131",
        "133",
        "135",
        "136",
        "139",
        "140",
        "143",
        "144",
      ]
    );
    assert.deepEqual(
      RENAMED_MIGRATION_COMPATIBILITY.find(
        (e) => e.fromVersion === "074" && e.fromName === "inspector_custom_hosts"
      ),
      {
        fromVersion: "074",
        fromName: "inspector_custom_hosts",
        toVersion: "081",
        toName: "inspector_custom_hosts",
      }
    );
    assert.deepEqual(RENAMED_MIGRATION_COMPATIBILITY.at(-8), {
      fromVersion: "134",
      fromName: "ccr_blocks",
      toVersion: "139",
      toName: "ccr_blocks",
    });
    assert.deepEqual(RENAMED_MIGRATION_COMPATIBILITY.at(-7), {
      fromVersion: "139",
      fromName: "job_registry",
      toVersion: "146",
      toName: "job_registry",
    });
    assert.deepEqual(RENAMED_MIGRATION_COMPATIBILITY.at(-6), {
      fromVersion: "143",
      fromName: "radar_local_model_state",
      toVersion: "153",
      toName: "radar_local_model_state",
    });
    // npm 3.8.50 shipped model_capabilities as 163; it now lives at 169
    assert.deepEqual(RENAMED_MIGRATION_COMPATIBILITY.at(-5), {
      fromVersion: "163",
      fromName: "model_capabilities",
      toVersion: "169",
      toName: "model_capabilities",
    });
    // #12036: renamed migrations 056/073/077/101 appended as compatibility renames
    assert.deepEqual(RENAMED_MIGRATION_COMPATIBILITY.at(-4), {
      fromVersion: "056",
      fromName: "provider_default",
      toVersion: "056",
      toName: "mcp_accessibility_compression",
    });
    assert.deepEqual(RENAMED_MIGRATION_COMPATIBILITY.at(-3), {
      fromVersion: "073",
      fromName: "discovery_results",
      toVersion: "073",
      toName: "per_model_token_limits",
    });
    assert.deepEqual(RENAMED_MIGRATION_COMPATIBILITY.at(-2), {
      fromVersion: "077",
      fromName: "plugin_metrics",
      toVersion: "077",
      toName: "api_key_stream_default_mode",
    });
    assert.deepEqual(RENAMED_MIGRATION_COMPATIBILITY.at(-1), {
      fromVersion: "101",
      fromName: "proxy_pool_rotation",
      toVersion: "101",
      toName: "api_key_usage_limits",
    });
  });

  it("PHYSICAL_SCHEMA_SENTINELS has 15 well-formed entries incl. the newest 064", () => {
    assert.equal(PHYSICAL_SCHEMA_SENTINELS.length, 15);
    for (const e of PHYSICAL_SCHEMA_SENTINELS) {
      assert.equal(typeof e.version, "string");
      assert.equal(typeof e.tableName, "string");
      assert.equal(typeof e.description, "string");
    }
    const byVersion = Object.fromEntries(
      PHYSICAL_SCHEMA_SENTINELS.map((e) => [e.version, e.tableName])
    );
    assert.equal(byVersion["064"], "session_model_history");
    assert.equal(byVersion["002"], "mcp_tool_audit");
    assert.equal(byVersion["028"], "batches");
  });
});
