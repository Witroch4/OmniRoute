-- Migration 112: Persist resolved per-request USD cost when the upstream response reports it.
ALTER TABLE usage_history ADD COLUMN cost_usd REAL DEFAULT NULL;
