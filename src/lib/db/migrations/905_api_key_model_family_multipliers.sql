-- Migration: per-API-key, per-model-family USD multiplier (normalized-only).
--
-- Independent of api_key_model_budget_rules (125): a redirect rule reroutes traffic once
-- a REAL weekly cap is crossed; this multiplier instead scales the NORMALIZED (billed)
-- cost of every request whose BILLED family matches -- whether or not any redirect ever
-- fires. It exists because billing a plain Sonnet request at Sonnet rates barely drains a
-- client's quota, so there is no cost pressure against choosing the cheap model directly.
-- Multiplying the normalized cost -- never the real one OmniRoute actually pays the
-- provider -- restores that pressure without changing what the operator pays upstream.
--
-- family_glob matches the same GLOB-over-bare-model-id convention as 125's source_family
-- (case-insensitive, matched against the BILLED model at read time -- what the client was
-- charged, not what actually served the request; a redirected row takes its ORIGINAL
-- family's multiplier, never the serving family's). multiplier is a plain decimal factor,
-- 1.0 = neutral/no-op. Absent, disabled, zero, negative, or unparseable values are NEVER
-- honored at read time -- they resolve to 1.0, since a 0 multiplier would make matching
-- spend read as zero and silently unblock every USD quota on the key (see
-- src/lib/usage/modelFamilyMultiplier.ts's neutral-fallback contract, the single shared
-- function every read- and write-time cost path goes through). Write-time validation
-- additionally caps multiplier at a sane upper bound (MAX_FAMILY_MULTIPLIER) so a
-- fat-fingered 150 (meant to be 1.50) can never be saved at all.
CREATE TABLE IF NOT EXISTS api_key_model_family_multipliers (
  id TEXT PRIMARY KEY,
  api_key_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 0,
  provider TEXT NOT NULL,
  family_glob TEXT NOT NULL,
  multiplier REAL NOT NULL DEFAULT 1.0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_akmfm_key ON api_key_model_family_multipliers(api_key_id, enabled);
