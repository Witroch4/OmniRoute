-- Migration: per-key @@om-usage USD display mode
ALTER TABLE api_keys ADD COLUMN usage_command_show_usd INTEGER NOT NULL DEFAULT 0;
