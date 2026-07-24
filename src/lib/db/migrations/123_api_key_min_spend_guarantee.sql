-- Migration: per-API-key minimum-spend guarantee (floor that overrides the cutoff)
-- The guarantee lets a key spend AT LEAST min_spend_guarantee_usd per rolling
-- weekly window, routing past the provider quota cutoff if necessary (like the
-- bypass scope, but gated on spend). Once the key's window spend reaches the
-- floor, the normal cutoff applies again. Scope is per-key, global across
-- providers; all window spend counts toward the floor. A hard USD ceiling
-- (usage_limit_enabled) still limits and is enforced before selection.
ALTER TABLE api_keys ADD COLUMN min_spend_guarantee_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE api_keys ADD COLUMN min_spend_guarantee_usd REAL;
