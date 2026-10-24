/**
 * db/migrationRunner/constants.ts — Static migration-compatibility data tables.
 *
 * Pure data (no imports, no DB, no behaviour) extracted verbatim from
 * migrationRunner.ts: the renamed/legacy/superseded migration maps and the
 * physical/initial schema sentinels used by the reconciliation, dedup, and
 * already-applied detection paths. Kept separate so the orchestrator host
 * file holds logic, not data tables.
 */

export const RENAMED_MIGRATION_COMPATIBILITY = [
  {
    fromVersion: "022",
    fromName: "call_logs_summary_storage",
    toVersion: "025",
    toName: "call_logs_summary_storage",
  },
  {
    fromVersion: "028",
    fromName: "provider_connection_max_concurrent",
    toVersion: "029",
    toName: "provider_connection_max_concurrent",
  },
  {
    fromVersion: "028",
    fromName: "compression_settings",
    toVersion: "034",
    toName: "compression_settings",
  },
  {
    fromVersion: "032",
    fromName: "create_reasoning_cache",
    toVersion: "033",
    toName: "create_reasoning_cache",
  },
  {
    fromVersion: "032",
    fromName: "compression_analytics",
    toVersion: "038",
    toName: "compression_analytics",
  },
  {
    fromVersion: "033",
    fromName: "compression_cache_stats",
    toVersion: "039",
    toName: "compression_cache_stats",
  },
  {
    fromVersion: "041",
    fromName: "session_account_affinity",
    toVersion: "050",
    toName: "session_account_affinity",
  },
  {
    fromVersion: "051",
    fromName: "usage_history_service_tier",
    toVersion: "054",
    toName: "usage_history_service_tier",
  },
  {
    fromVersion: "052",
    fromName: "manifest_routing",
    toVersion: "059",
    toName: "manifest_routing",
  },
  {
    fromVersion: "056",
    fromName: "manifest_routing",
    toVersion: "059",
    toName: "manifest_routing",
  },
  // ── Fork-only migrations live in a RESERVED block, 900–907 (sync to upstream 3.8.53,
  // 2026-10-24). History: they were 123–129 until 2026-09-01, then 164–171, and upstream
  // reused BOTH ranges for different migrations (123–129: quota_auto_ping …
  // usage_history_codex_strong_identity; 164–171: retire_microsoft_designer_web …
  // restore_chatgpt_web_cleanroom). getAppliedVersions() keys on the version NUMBER
  // alone, so a ledger that still records ours on those numbers would make the runner
  // skip upstream's migrations in silence — the container boots healthy and then fails at
  // runtime on the missing columns/tables. The 900 block sits far above upstream's
  // sequence so the next syncs do not collide again.
  //
  // These entries let reconcileRenumberedMigrations() rewrite the ledger itself at boot,
  // inside a transaction. A production ledger carries each fork migration TWICE (old
  // 123–129 row + 164–170 row) plus 171: the first matching entry moves a row to 9xx, the
  // second finds the 9xx row already there and deletes the stale duplicate. Matching is by
  // NAME, so a database that never had the fork migrations has nothing to move.
  // isSchemaAlreadyApplied() carries the 900–907 probes as the second line of defence.
  {
    fromVersion: "123",
    fromName: "api_key_min_spend_guarantee",
    toVersion: "900",
    toName: "api_key_min_spend_guarantee",
  },
  {
    fromVersion: "164",
    fromName: "api_key_min_spend_guarantee",
    toVersion: "900",
    toName: "api_key_min_spend_guarantee",
  },
  {
    fromVersion: "124",
    fromName: "quota_snapshots_window_index",
    toVersion: "901",
    toName: "quota_snapshots_window_index",
  },
  {
    fromVersion: "165",
    fromName: "quota_snapshots_window_index",
    toVersion: "901",
    toName: "quota_snapshots_window_index",
  },
  {
    fromVersion: "125",
    fromName: "api_key_model_budget_rules",
    toVersion: "902",
    toName: "api_key_model_budget_rules",
  },
  {
    fromVersion: "166",
    fromName: "api_key_model_budget_rules",
    toVersion: "902",
    toName: "api_key_model_budget_rules",
  },
  {
    fromVersion: "126",
    fromName: "usage_history_billed_model",
    toVersion: "903",
    toName: "usage_history_billed_model",
  },
  {
    fromVersion: "167",
    fromName: "usage_history_billed_model",
    toVersion: "903",
    toName: "usage_history_billed_model",
  },
  {
    fromVersion: "127",
    fromName: "domain_cost_history_billed_cost",
    toVersion: "904",
    toName: "domain_cost_history_billed_cost",
  },
  {
    fromVersion: "168",
    fromName: "domain_cost_history_billed_cost",
    toVersion: "904",
    toName: "domain_cost_history_billed_cost",
  },
  {
    fromVersion: "128",
    fromName: "api_key_model_family_multipliers",
    toVersion: "905",
    toName: "api_key_model_family_multipliers",
  },
  {
    fromVersion: "169",
    fromName: "api_key_model_family_multipliers",
    toVersion: "905",
    toName: "api_key_model_family_multipliers",
  },
  {
    fromVersion: "129",
    fromName: "api_key_renewal_cycle",
    toVersion: "906",
    toName: "api_key_renewal_cycle",
  },
  {
    fromVersion: "170",
    fromName: "api_key_renewal_cycle",
    toVersion: "906",
    toName: "api_key_renewal_cycle",
  },
  {
    fromVersion: "171",
    fromName: "usage_history_client_ip",
    toVersion: "907",
    toName: "usage_history_client_ip",
  },
  {
    fromVersion: "123",
    fromName: "windsurf_to_devin_desktop",
    toVersion: "151",
    toName: "windsurf_to_devin_desktop",
  },
  {
    fromVersion: "124",
    fromName: "windsurf_to_devin_desktop",
    toVersion: "151",
    toName: "windsurf_to_devin_desktop",
  },
  {
    fromVersion: "125",
    fromName: "windsurf_to_devin_desktop",
    toVersion: "151",
    toName: "windsurf_to_devin_desktop",
  },
  {
    fromVersion: "126",
    fromName: "windsurf_to_devin_desktop",
    toVersion: "151",
    toName: "windsurf_to_devin_desktop",
  },
  {
    fromVersion: "127",
    fromName: "windsurf_to_devin_desktop",
    toVersion: "151",
    toName: "windsurf_to_devin_desktop",
  },
  {
    fromVersion: "128",
    fromName: "windsurf_to_devin_desktop",
    toVersion: "151",
    toName: "windsurf_to_devin_desktop",
  },
  {
    fromVersion: "131",
    fromName: "windsurf_to_devin_desktop",
    toVersion: "151",
    toName: "windsurf_to_devin_desktop",
  },
  {
    // 133 collided with 133_call_logs_session_tag once that landed on release.
    fromVersion: "133",
    fromName: "windsurf_to_devin_desktop",
    toVersion: "151",
    toName: "windsurf_to_devin_desktop",
  },
  {
    // 135 and 136 are canonical release migrations now.
    fromVersion: "135",
    fromName: "windsurf_to_devin_desktop",
    toVersion: "151",
    toName: "windsurf_to_devin_desktop",
  },
  {
    fromVersion: "136",
    fromName: "windsurf_to_devin_desktop",
    toVersion: "151",
    toName: "windsurf_to_devin_desktop",
  },
  {
    // 139 and 140 are occupied by CCR and connection runtime state.
    fromVersion: "139",
    fromName: "windsurf_to_devin_desktop",
    toVersion: "151",
    toName: "windsurf_to_devin_desktop",
  },
  {
    fromVersion: "140",
    fromName: "windsurf_to_devin_desktop",
    toVersion: "151",
    toName: "windsurf_to_devin_desktop",
  },
  {
    // 143 is the API-key cache mode; 144–145 are the stacked Radar caches.
    fromVersion: "143",
    fromName: "windsurf_to_devin_desktop",
    toVersion: "151",
    toName: "windsurf_to_devin_desktop",
  },
  {
    // 144 was published by this PR before the Radar reservation landed.
    fromVersion: "144",
    fromName: "windsurf_to_devin_desktop",
    toVersion: "151",
    toName: "windsurf_to_devin_desktop",
  },
  {
    // inspector_custom_hosts was once published in slot 074, now occupied by
    // discovery_results. Its canonical idempotent migration lives at 081.
    fromVersion: "074",
    fromName: "inspector_custom_hosts",
    toVersion: "081",
    toName: "inspector_custom_hosts",
  },
  {
    fromVersion: "134",
    fromName: "ccr_blocks",
    toVersion: "139",
    toName: "ccr_blocks",
  },
  {
    fromVersion: "139",
    fromName: "job_registry",
    toVersion: "146",
    toName: "job_registry",
  },
  {
    // The cumulative Radar branch used 143 before 143_api_key_cache_default_mode
    // landed on release/v3.8.50. Rehome already-applied Radar rows to the next
    // free slot so the canonical API-key migration can still run.
    fromVersion: "143",
    fromName: "radar_local_model_state",
    toVersion: "153",
    toName: "radar_local_model_state",
  },
  {
    // npm omniroute@3.8.50 was built from main at dea6bb8 (per its provenance
    // attestation), which shipped model_capabilities as 163. 70f5d4cbf then moved it
    // to 169 so 163_radar_feed_cache_generated_at could keep its slot. Without this
    // entry, a database first migrated by that npm build keeps its 163 ledger row,
    // so the release's 163 is treated as applied and never runs: radar_feed_cache
    // never gets generated_at, and every boot logs the renumbering CRITICAL.
    fromVersion: "163",
    fromName: "model_capabilities",
    toVersion: "169",
    toName: "model_capabilities",
  },
  {
    fromVersion: "056",
    fromName: "provider_default",
    toVersion: "056",
    toName: "mcp_accessibility_compression",
  },
  {
    fromVersion: "073",
    fromName: "discovery_results",
    toVersion: "073",
    toName: "per_model_token_limits",
  },
  {
    fromVersion: "077",
    fromName: "plugin_metrics",
    toVersion: "077",
    toName: "api_key_stream_default_mode",
  },
  {
    fromVersion: "101",
    fromName: "proxy_pool_rotation",
    toVersion: "101",
    toName: "api_key_usage_limits",
  },
] as const;

export const LEGACY_VERSION_SLOT_MIGRATIONS = [
  { version: "028", name: "evals_tables" },
  { version: "029", name: "webhooks_templates" },
  { version: "030", name: "mcp_scopes_api_keys" },
  { version: "031", name: "api_keys_expires" },
  { version: "032", name: "detailed_logs_warnings" },
  { version: "033", name: "provider_connections_block_extra_usage" },
  { version: "033", name: "add_batch_id_to_call_logs" },
  { version: "046", name: "remove_status_from_files" },
  { version: "051", name: "remove_status_from_files" },
  // Fork rows from the v3.8.29–v3.8.36 era that still occupy slots now owned by upstream
  // migrations (100_cli_access_tokens, 104_normalize_database_cache_size,
  // 105_usage_history_endpoint). The first two are duplicates of rows already recorded at
  // their final numbers (101_api_key_usage_limits, 108_provider_quota_reset_events); the
  // third added a column nothing reads any more. Rehoming them lets upstream's three run —
  // without it the `cli_access_tokens` table never exists on such a database.
  { version: "100", name: "api_key_usage_limits" },
  { version: "104", name: "provider_quota_reset_events" },
  { version: "105", name: "usage_command_show_usd" },
] as const;

export const SUPERSEDED_DUPLICATE_MIGRATIONS = [
  {
    version: "041",
    name: "session_account_affinity",
    supersededByVersion: "050",
    supersededByName: "session_account_affinity",
  },
] as const;

export const PHYSICAL_SCHEMA_SENTINELS = [
  { version: "028", tableName: "batches", description: "batches table" },
  { version: "024", tableName: "sync_tokens", description: "sync_tokens table" },
  { version: "022", tableName: "memory_fts", description: "memory_fts virtual table" },
  { version: "019", tableName: "context_handoffs", description: "context_handoffs table" },
  {
    version: "064",
    tableName: "session_model_history",
    description: "session_model_history table",
  },
  { version: "017", tableName: "version_manager", description: "version_manager table" },
  { version: "016", tableName: "skill_executions", description: "skill_executions table" },
  { version: "015", tableName: "memories", description: "memories table" },
  { version: "013", tableName: "quota_snapshots", description: "quota_snapshots table" },
  { version: "011", tableName: "webhooks", description: "webhooks table" },
  { version: "010", tableName: "model_combo_mappings", description: "model_combo_mappings table" },
  { version: "008", tableName: "registered_keys", description: "registered_keys table" },
  { version: "006", tableName: "request_detail_logs", description: "request_detail_logs table" },
  { version: "004", tableName: "proxy_registry", description: "proxy_registry table" },
  { version: "002", tableName: "mcp_tool_audit", description: "mcp_tool_audit table" },
] as const;

export const INITIAL_SCHEMA_SENTINELS = ["provider_connections", "combos", "call_logs"] as const;
// "178" (#13717) and "203" (#15707) recreate memory_fts and hard-fail on sql.js/no-FTS5
// drivers. If #13331 (adds "180") lands before this, reconcile to the union
// ({"022","023","178","180","203"}) and update the assertion in
// tests/unit/db-migrationrunner-constants-split.test.ts accordingly.
export const OPTIONAL_FTS5_MIGRATION_VERSIONS = new Set(["022", "023", "178", "203"]);
