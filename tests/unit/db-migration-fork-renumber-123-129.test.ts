/**
 * Fork migrations renumbered 123–129 → 164–170 (2026-09-01 upstream sync).
 *
 * Upstream had independently used 123–129 for seven DIFFERENT migrations. Because
 * `getAppliedVersions()` keys on the version NUMBER alone, a production database that
 * recorded OUR migrations at 123–129 would make the runner treat upstream's seven as
 * already applied and skip them silently — the container boots healthy and only then
 * fails at runtime on the missing columns and tables.
 *
 * The fix has two halves and this file exercises both:
 *
 *  1. `RENAMED_MIGRATION_COMPATIBILITY` entries so `reconcileRenumberedMigrations()`
 *     moves the ledger rows 123→164 … 129→170 at boot, freeing 123–129 for upstream.
 *  2. `isSchemaAlreadyApplied()` cases for 164/166/167/168/169/170, so the four
 *     ALTER-based migrations cannot re-run and die on "duplicate column name" on a
 *     database where the reconcile did not fire.
 *
 * The third test is the one that keeps half 2 honest: those same guards must NOT
 * suppress the migrations on a fresh database, or a new install silently loses the
 * fork-only schema.
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

/** The seven fork migrations, at their NEW numbers, read verbatim from disk. */
const FORK_MIGRATIONS: Array<{ version: string; file: string; sql: string }> = [
  { version: "164", file: "164_api_key_min_spend_guarantee.sql", sql: "" },
  { version: "165", file: "165_quota_snapshots_window_index.sql", sql: "" },
  { version: "166", file: "166_api_key_model_budget_rules.sql", sql: "" },
  { version: "167", file: "167_usage_history_billed_model.sql", sql: "" },
  { version: "168", file: "168_domain_cost_history_billed_cost.sql", sql: "" },
  { version: "169", file: "169_api_key_model_family_multipliers.sql", sql: "" },
  { version: "170", file: "170_api_key_renewal_cycle.sql", sql: "" },
].map((entry) => ({
  ...entry,
  sql: fs.readFileSync(path.resolve("src/lib/db/migrations", entry.file), "utf8"),
}));

/** The old (pre-renumber) name each one was recorded under in the production ledger. */
const OLD_LEDGER_ROWS = [
  { version: "123", name: "api_key_min_spend_guarantee" },
  { version: "124", name: "quota_snapshots_window_index" },
  { version: "125", name: "api_key_model_budget_rules" },
  { version: "126", name: "usage_history_billed_model" },
  { version: "127", name: "domain_cost_history_billed_cost" },
  { version: "128", name: "api_key_model_family_multipliers" },
  { version: "129", name: "api_key_renewal_cycle" },
];

/**
 * Stand-ins for upstream's 123–129. Only their VERSION SLOT matters here: each creates a
 * table whose presence proves the runner stopped skipping that number.
 */
const UPSTREAM_MIGRATIONS = [
  { version: "123", file: "123_quota_auto_ping.sql", table: "upstream_quota_auto_ping" },
  {
    version: "124",
    file: "124_generic_session_affinity_ttl.sql",
    table: "upstream_session_affinity_ttl",
  },
  {
    version: "125",
    file: "125_provider_connection_quota_visibility.sql",
    table: "upstream_quota_visibility",
  },
  { version: "126", file: "126_reasoning_routing_rules.sql", table: "upstream_reasoning_rules" },
  {
    version: "127",
    file: "127_usage_history_account_identity.sql",
    table: "upstream_account_identity",
  },
  { version: "128", file: "128_auto_candidate_overrides.sql", table: "upstream_candidate_overrides" },
  {
    version: "129",
    file: "129_usage_history_codex_strong_identity.sql",
    table: "upstream_codex_identity",
  },
];

function migrationFileMap(options: { includeUpstream: boolean }): Record<string, string> {
  const files: Record<string, string> = {};
  if (options.includeUpstream) {
    for (const migration of UPSTREAM_MIGRATIONS) {
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

/** The base tables the seven fork migrations ALTER / index. */
function createBaseSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE api_keys (id TEXT PRIMARY KEY);
    CREATE TABLE usage_history (id TEXT PRIMARY KEY);
    CREATE TABLE domain_cost_history (id TEXT PRIMARY KEY);
    CREATE TABLE quota_snapshots (
      connection_id TEXT,
      window_key TEXT,
      created_at TEXT
    );
  `);
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

test(
  "production ledger at 123-129 is rewritten to 164-170, freeing the slots for upstream",
  serial,
  async () => {
    const runner = await importFresh("src/lib/db/migrationRunner.ts");
    const db = new Database(":memory:");

    try {
      // Reproduce production: the fork schema is already applied and recorded at 123–129.
      createBaseSchema(db);
      for (const migration of FORK_MIGRATIONS) db.exec(migration.sql);
      db.exec(`
        CREATE TABLE _omniroute_migrations (
          version TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
      const insert = db.prepare("INSERT INTO _omniroute_migrations (version, name) VALUES (?, ?)");
      for (const row of OLD_LEDGER_ROWS) insert.run(row.version, row.name);

      const applied = withMockedMigrationFs(migrationFileMap({ includeUpstream: true }), () =>
        runner.runMigrations(db)
      );

      // Upstream's seven ran; ours did not re-run.
      assert.equal(applied, UPSTREAM_MIGRATIONS.length);
      for (const migration of UPSTREAM_MIGRATIONS) {
        assert.ok(
          tableExists(db, migration.table),
          `upstream ${migration.version} was skipped — its version slot is still occupied`
        );
      }

      // The ledger now records the fork migrations at their NEW numbers, and 123–129
      // belong to upstream.
      const rows = ledgerRows(db);
      assert.deepEqual(
        rows.filter((row) => Number(row.version) >= 164),
        [
          { version: "164", name: "api_key_min_spend_guarantee" },
          { version: "165", name: "quota_snapshots_window_index" },
          { version: "166", name: "api_key_model_budget_rules" },
          { version: "167", name: "usage_history_billed_model" },
          { version: "168", name: "domain_cost_history_billed_cost" },
          { version: "169", name: "api_key_model_family_multipliers" },
          { version: "170", name: "api_key_renewal_cycle" },
        ]
      );
      assert.deepEqual(
        rows.filter((row) => Number(row.version) <= 129).map((row) => row.name),
        UPSTREAM_MIGRATIONS.map((migration) =>
          migration.file.replace(/^\d+_/, "").replace(/\.sql$/, "")
        )
      );

      // The fork schema survived untouched — one column each, not two.
      const apiKeyColumns = columnNames(db, "api_keys");
      assert.equal(
        apiKeyColumns.filter((name) => name === "min_spend_guarantee_enabled").length,
        1
      );
      assert.equal(apiKeyColumns.filter((name) => name === "renewal_cycle_enabled").length, 1);
    } finally {
      db.close();
    }
  }
);

test(
  "fork migrations do not re-run when the ledger already carries the new numbers",
  serial,
  async () => {
    const runner = await importFresh("src/lib/db/migrationRunner.ts");
    const db = new Database(":memory:");

    try {
      createBaseSchema(db);
      for (const migration of FORK_MIGRATIONS) db.exec(migration.sql);
      db.exec(`
        CREATE TABLE _omniroute_migrations (
          version TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
      // Ledger wiped of the fork rows — the reconcile has nothing to move, so only the
      // isSchemaAlreadyApplied guards stand between us and "duplicate column name".
      const applied = withMockedMigrationFs(migrationFileMap({ includeUpstream: false }), () =>
        runner.runMigrations(db)
      );

      assert.equal(applied, FORK_MIGRATIONS.length);
      assert.equal(
        columnNames(db, "api_keys").filter((name) => name === "min_spend_guarantee_enabled").length,
        1
      );
      assert.deepEqual(
        ledgerRows(db).map((row) => row.version),
        FORK_MIGRATIONS.map((migration) => migration.version)
      );
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

    assert.equal(applied, FORK_MIGRATIONS.length);

    // Every guard in isSchemaAlreadyApplied must read false here, or the migration is
    // skipped and a new install silently loses the feature.
    const apiKeyColumns = columnNames(db, "api_keys");
    assert.ok(apiKeyColumns.includes("min_spend_guarantee_enabled"));
    assert.ok(apiKeyColumns.includes("min_spend_guarantee_usd"));
    assert.ok(apiKeyColumns.includes("renewal_cycle_enabled"));
    assert.ok(apiKeyColumns.includes("renewal_cycle_anchor_at"));
    assert.ok(apiKeyColumns.includes("renewal_cycle_months"));
    assert.ok(columnNames(db, "usage_history").includes("billed_provider"));
    assert.ok(columnNames(db, "usage_history").includes("billed_model"));
    assert.ok(columnNames(db, "domain_cost_history").includes("billed_cost"));
    assert.ok(tableExists(db, "api_key_model_budget_rules"));
    assert.ok(tableExists(db, "api_key_model_family_multipliers"));
  } finally {
    db.close();
  }
});

test("the reconcile is a no-op on a database that never had the fork migrations", serial, async () => {
  const runner = await importFresh("src/lib/db/migrationRunner.ts");
  const db = new Database(":memory:");

  try {
    createBaseSchema(db);
    db.exec(`
      CREATE TABLE _omniroute_migrations (
        version TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    // Upstream's own 123–129, already applied — the shape any non-fork deployment has.
    const insert = db.prepare("INSERT INTO _omniroute_migrations (version, name) VALUES (?, ?)");
    for (const migration of UPSTREAM_MIGRATIONS) {
      insert.run(migration.version, migration.file.replace(/^\d+_/, "").replace(/\.sql$/, ""));
    }

    withMockedMigrationFs(migrationFileMap({ includeUpstream: true }), () =>
      runner.runMigrations(db)
    );

    // Upstream's rows were left exactly where they were — nothing got rewritten to 164+.
    const rows = ledgerRows(db);
    assert.deepEqual(
      rows.filter((row) => Number(row.version) <= 129).map((row) => row.version),
      UPSTREAM_MIGRATIONS.map((migration) => migration.version)
    );
  } finally {
    db.close();
  }
});
