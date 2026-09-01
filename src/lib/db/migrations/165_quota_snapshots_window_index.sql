-- Migration: composite index for per-window latest-snapshot lookups.
-- getLatestQuotaSnapshotsForConnection() now joins on (connection_id, window_key,
-- created_at) to find each window's latest row instead of scanning the last 200
-- rows for the connection — a fast-churning window (e.g. a short-lived per-window
-- quota that gets re-fetched every few minutes) was pushing a quiet window's last
-- known value out of that fixed-size scan, making the quiet window vanish from the
-- rehydrated quota cache entirely.
CREATE INDEX IF NOT EXISTS idx_quota_snapshots_connection_window_time
  ON quota_snapshots(connection_id, window_key, created_at);
