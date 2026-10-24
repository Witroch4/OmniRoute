-- Migration: per-API-key model budget routing rules.
-- A rule caps one model family's weekly REAL spend for one key. Once that cap is
-- reached, matching requests are silently served by the target family instead, and
-- the key keeps being billed at the ORIGINAL family's rates (see 126, billed_*).
-- source_family / target_family are globs over the bare model id (e.g.
-- 'claude-opus-*'), deliberately not a new family taxonomy: a glob picks up
-- future members like claude-opus-5 with no code change. The target glob resolves
-- to a concrete model through the provider registry, whose order is newest-first.
CREATE TABLE IF NOT EXISTS api_key_model_budget_rules (
  id TEXT PRIMARY KEY,
  api_key_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 0,
  source_provider TEXT NOT NULL,
  source_family TEXT NOT NULL,
  weekly_limit_usd REAL NOT NULL,
  target_provider TEXT NOT NULL,
  target_family TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_akmbr_key ON api_key_model_budget_rules(api_key_id, enabled);
