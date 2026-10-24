/**
 * Fork migrations moved into the reserved 900–907 block (2026-10-24 upstream sync to 3.8.53).
 *
 * The fork's eight migrations lived at 123–129 until 2026-09-01, then at 164–171, and upstream
 * reused BOTH ranges for different migrations. `getAppliedVersions()` keys on the version
 * NUMBER alone, so a production database that still records ours on those numbers would make
 * the runner treat upstream's migrations as applied and skip them silently — the container
 * boots healthy and only then fails at runtime on the missing columns and tables.
 *
 * Production is in the worst shape of all: every fork migration is recorded TWICE (the
 * original 123–129 row survived the 2026-09-01 staged renumber next to its 164–170 row), and
 * three rows from the v3.8.29–v3.8.36 era (100/104/105) sit on slots upstream now owns.
 * This file reproduces that ledger and proves:
 *
 *  1. `RENAMED_MIGRATION_COMPATIBILITY` moves the fork rows to 900–907 and deletes the stale
 *     duplicates, freeing 123–129 and 164–171 for upstream.
 *  2. `LEGACY_VERSION_SLOT_MIGRATIONS` rehomes the 100/104/105 rows so upstream's
 *     100_cli_access_tokens, 104_normalize_database_cache_size and 105_usage_history_endpoint
 *     can apply.
 *  3. `isSchemaAlreadyApplied()` keeps the ALTER-based fork migrations from re-running when
 *     the reconcile did not fire, and still lets them run on a FRESH database.
 *  4. The old fork probes "164".."171" are gone: they would answer for upstream's 164–171.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";

const serial = { concurrency: false };

async function importFresh(modulePath: string) {
  const url = pathToFileURL(path.resolve(modulePath)).href;
  return import(`${url}?test=${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

const FORK_NAMES = [
  "api_key_min_spend_guarantee",
  "quota_snapshots_window_index",
  "api_key_model_budget_rules",
  "usage_history_billed_model",
  "domain_cost_history_billed_cost",
  "api_key_model_family_multipliers",
  "api_key_renewal_cycle",
  "usage_history_client_ip",
];

/** The eight fork migrations at their 900-block numbers, read verbatim from disk. */
const FORK_MIGRATIONS = FORK_NAMES.map((name, index) => {
  const version = String(900 + index);
  const file = `${version}_${name}.sql`;
  return {
    version,
    name,
    file,
    sql: fs.readFileSync(path.resolve("src/lib/db/migrations", file), "utf8"),
  };
});

/** What the production ledger carries for the fork migrations today. */
const PRODUCTION_FORK_ROWS = [
  ...FORK_NAMES.slice(0, 7).map((name, index) => ({ version: String(123 + index), name })),
  ...FORK_NAMES.map((name, index) => ({ version: String(164 + index), name })),
];

/** Fork rows from the v3.8.29–v3.8.36 era plus the upstream rows already at their final slots. */
const PRODUCTION_OLD_ERA_ROWS = [
  { version: "100", name: "api_key_usage_limits" },
  { version: "101", name: "api_key_usage_limits" },
  { version: "104", name: "provider_quota_reset_events" },
  { version: "105", name: "usage_command_show_usd" },
  { version: "108", name: "provider_quota_reset_events" },
];

/**
 * Stand-ins for upstream's migrations on the contested slots. Only the VERSION SLOT matters:
 * each creates a table whose presence proves the runner stopped skipping that number.
 */
const UPSTREAM_ON_CONTESTED_SLOTS = [
  { version: "100", name: "cli_access_tokens" },
  { version: "104", name: "normalize_database_cache_size" },
  { version: "105", name: "usage_history_endpoint" },
  { version: "123", name: "quota_auto_ping" },
  { version: "124", name: "generic_session_affinity_ttl" },
  { version: "125", name: "provider_connection_quota_visibility" },
  { version: "126", name: "reasoning_routing_rules" },
  { version: "127", name: "usage_history_account_identity" },
  { version: "128", name: "auto_candidate_overrides" },
  { version: "129", name: "usage_history_codex_strong_identity" },
  { version: "164", name: "retire_microsoft_designer_web" },
  { version: "165", name: "retire_felo_web" },
  { version: "166", name: "retire_gpl_derived_providers" },
  { version: "167", name: "retire_qwen_web" },
  { version: "168", name: "retire_chatgpt_web" },
  { version: "169", name: "model_capabilities" },
  { version: "170", name: "log_export_destinations" },
  { version: "171", name: "restore_chatgpt_web_cleanroom" },
].map((migration) => ({
  ...migration,
  file: `${migration.version}_${migration.name}.sql`,
  table: `upstream_${migration.version}_${migration.name}`,
}));

/** Upstream migrations already recorded under their own names: they must NOT re-run. */
const UPSTREAM_ALREADY_APPLIED = [
  { version: "101", name: "api_key_usage_limits" },
  { version: "108", name: "provider_quota_reset_events" },
].map((migration) => ({
  ...migration,
  file: `${migration.version}_${migration.name}.sql`,
  table: `upstream_${migration.version}_${migration.name}`,
}));

function migrationFileMap(options: { includeUpstream: boolean }): Record<string, string> {
  const files: Record<string, string> = {};
  if (options.includeUpstream) {
    for (const migration of [...UPSTREAM_ON_CONTESTED_SLOTS, ...UPSTREAM_ALREADY_APPLIED]) {
      files[migration.file] = `CREATE TABLE ${migration.table} (id INTEGER);`;
    }
  }
  for (const migration of FORK_MIGRATIONS) {
    files[migration.file] = migration.sql;
  }
  return files;
}

function withMockedMigrationFs<T>(files: Record<string, string>, fn: () => T): T {
  const originalExistsSync = fs.existsSync;
  const originalReaddirSync = fs.readdirSync;
  const originalReadFileSync = fs.readFileSync;

  const isMigrationDir = (target: unknown) =>
    String(target).replaceAll("\\", "/").endsWith("/src/lib/db/migrations") ||
    String(target).replaceAll("\\", "/").endsWith("/migrations");

  fs.existsSync = ((target: fs.PathLike) => {
    if (isMigrationDir(target)) return true;
    if (Object.hasOwn(files, path.basename(String(target)))) return true;
    return originalExistsSync(target);
  }) as typeof fs.existsSync;

  fs.readdirSync = ((target: fs.PathLike, options?: unknown) => {
    if (isMigrationDir(target)) return Object.keys(files);
    return (originalReaddirSync as (t: fs.PathLike, o?: unknown) => unknown)(target, options);
  }) as typeof fs.readdirSync;

  fs.readFileSync = ((target: fs.PathLike, options?: unknown) => {
    const fileName = path.basename(String(target));
    if (Object.hasOwn(files, fileName)) return files[fileName];
    return (originalReadFileSync as (t: fs.PathLike, o?: unknown) => unknown)(target, options);
  }) as typeof fs.readFileSync;

  try {
    return fn();
  } finally {
    fs.existsSync = originalExistsSync;
    fs.readdirSync = originalReaddirSync;
    fs.readFileSync = originalReadFileSync;
  }
}

/** The base tables the fork migrations ALTER / index. */
function createBaseSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE api_keys (id TEXT PRIMARY KEY);
    CREATE TABLE usage_history (id TEXT PRIMARY KEY, api_key_id TEXT, timestamp TEXT);
    CREATE TABLE domain_cost_history (id TEXT PRIMARY KEY);
    CREATE TABLE quota_snapshots (
      connection_id TEXT,
      window_key TEXT,
      created_at TEXT
    );
  `);
}

function createLedger(db: Database.Database, rows: Array<{ version: string; name: string }>) {
  db.exec(`
    CREATE TABLE _omniroute_migrations (
      version TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const insert = db.prepare("INSERT INTO _omniroute_migrations (version, name) VALUES (?, ?)");
  for (const row of rows) insert.run(row.version, row.name);
}

function ledgerRows(db: Database.Database): Array<{ version: string; name: string }> {
  return db
    .prepare("SELECT version, name FROM _omniroute_migrations ORDER BY version")
    .all() as Array<{ version: string; name: string }>;
}

function columnNames(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (column) => column.name
  );
}

function tableExists(db: Database.Database, table: string): boolean {
  return Boolean(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
  );
}

function assertForkSchemaOnce(db: Database.Database): void {
  const apiKeyColumns = columnNames(db, "api_keys");
  for (const column of [
    "min_spend_guarantee_enabled",
    "min_spend_guarantee_usd",
    "renewal_cycle_enabled",
    "renewal_cycle_anchor_at",
    "renewal_cycle_months",
  ]) {
    assert.equal(apiKeyColumns.filter((name) => name === column).length, 1, column);
  }
  const usageColumns = columnNames(db, "usage_history");
  for (const column of ["billed_provider", "billed_model", "client_ip"]) {
    assert.equal(usageColumns.filter((name) => name === column).length, 1, column);
  }
  assert.ok(columnNames(db, "domain_cost_history").includes("billed_cost"));
  assert.ok(tableExists(db, "api_key_model_budget_rules"));
  assert.ok(tableExists(db, "api_key_model_family_multipliers"));
}

test(
  "production ledger: fork rows move to 900–907 and every contested slot goes to upstream",
  serial,
  async () => {
    const runner = await importFresh("src/lib/db/migrationRunner.ts");
    const db = new Database(":memory:");

    try {
      // Reproduce production: fork schema applied, recorded at 123–129 AND 164–171, plus the
      // three old-era rows on 100/104/105.
      createBaseSchema(db);
      for (const migration of FORK_MIGRATIONS) db.exec(migration.sql);
      createLedger(db, [...PRODUCTION_OLD_ERA_ROWS, ...PRODUCTION_FORK_ROWS]);

      const applied = withMockedMigrationFs(migrationFileMap({ includeUpstream: true }), () =>
        runner.runMigrations(db)
      );

      // Upstream's migrations on every contested slot ran; ours did not re-run, and the
      // upstream ones already recorded under their own names did not run twice.
      assert.equal(applied, UPSTREAM_ON_CONTESTED_SLOTS.length);
      for (const migration of UPSTREAM_ON_CONTESTED_SLOTS) {
        assert.ok(
          tableExists(db, migration.table),
          `upstream ${migration.version}_${migration.name} was skipped — its slot is still occupied`
        );
      }
      for (const migration of UPSTREAM_ALREADY_APPLIED) {
        assert.equal(tableExists(db, migration.table), false, `${migration.file} re-ran`);
      }

      const rows = ledgerRows(db);
      // The fork migrations are recorded exactly once each, in the 900 block.
      assert.deepEqual(
        rows.filter((row) => /^9\d\d$/.test(row.version)),
        FORK_MIGRATIONS.map((migration) => ({ version: migration.version, name: migration.name }))
      );
      // Every contested slot now carries upstream's name.
      for (const migration of UPSTREAM_ON_CONTESTED_SLOTS) {
        assert.deepEqual(
          rows.find((row) => row.version === migration.version),
          { version: migration.version, name: migration.name }
        );
      }
      // The old-era rows were rehomed, not lost.
      assert.deepEqual(
        rows.filter((row) => row.version.startsWith("legacy-")).map((row) => row.version),
        [
          "legacy-100-api_key_usage_limits",
          "legacy-104-provider_quota_reset_events",
          "legacy-105-usage_command_show_usd",
        ]
      );

      assertForkSchemaOnce(db);
    } finally {
      db.close();
    }
  }
);

test(
  "fork migrations do not re-run when the ledger lost their rows but the schema is there",
  serial,
  async () => {
    const runner = await importFresh("src/lib/db/migrationRunner.ts");
    const db = new Database(":memory:");

    try {
      createBaseSchema(db);
      for (const migration of FORK_MIGRATIONS) db.exec(migration.sql);
      // Ledger without any fork row: the reconcile has nothing to move, so only the
      // isSchemaAlreadyApplied probes stand between us and a duplicated column.
      createLedger(db, []);

      const applied = withMockedMigrationFs(migrationFileMap({ includeUpstream: false }), () =>
        runner.runMigrations(db)
      );

      assert.equal(applied, FORK_MIGRATIONS.length);
      assert.deepEqual(
        ledgerRows(db).map((row) => row.version),
        FORK_MIGRATIONS.map((migration) => migration.version)
      );
      assertForkSchemaOnce(db);
    } finally {
      db.close();
    }
  }
);

test("a fresh database still gets the fork-only schema", serial, async () => {
  const runner = await importFresh("src/lib/db/migrationRunner.ts");
  const db = new Database(":memory:");

  try {
    createBaseSchema(db);

    const applied = withMockedMigrationFs(migrationFileMap({ includeUpstream: false }), () =>
      runner.runMigrations(db)
    );

    // Every probe in isSchemaAlreadyApplied must read false here, or the migration is
    // skipped and a new install silently loses the feature.
    assert.equal(applied, FORK_MIGRATIONS.length);
    assertForkSchemaOnce(db);
  } finally {
    db.close();
  }
});

test(
  "a non-fork database keeps upstream's rows and the old fork probes no longer skip upstream",
  serial,
  async () => {
    const runner = await importFresh("src/lib/db/migrationRunner.ts");
    const db = new Database(":memory:");

    try {
      // A database that HAS the fork columns (so a stale "164".."171" probe would answer
      // true) but whose ledger only knows upstream's 123–129. Upstream's 164–171 are pending
      // and must run — they would be skipped if the old fork probes were still keyed there.
      createBaseSchema(db);
      for (const migration of FORK_MIGRATIONS) db.exec(migration.sql);
      createLedger(
        db,
        UPSTREAM_ON_CONTESTED_SLOTS.filter((migration) => Number(migration.version) <= 129).map(
          (migration) => ({ version: migration.version, name: migration.name })
        )
      );

      withMockedMigrationFs(migrationFileMap({ includeUpstream: true }), () =>
        runner.runMigrations(db)
      );

      for (const migration of UPSTREAM_ON_CONTESTED_SLOTS.filter(
        (candidate) => Number(candidate.version) >= 164
      )) {
        assert.ok(
          tableExists(db, migration.table),
          `upstream ${migration.version}_${migration.name} was skipped by a stale fork probe`
        );
      }
      const rows = ledgerRows(db);
      for (const migration of UPSTREAM_ON_CONTESTED_SLOTS) {
        assert.equal(rows.find((row) => row.version === migration.version)?.name, migration.name);
      }
    } finally {
      db.close();
    }
  }
);
