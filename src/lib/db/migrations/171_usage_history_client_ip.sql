-- Migration: per-request client IP on usage_history (who consumed from which machine).
--
-- OmniRoute is reached over the tailnet through `tailscale serve` (TCP + PROXY
-- protocol) and a local nginx that rewrites every client-IP header with the PROXY
-- address, so the header OM reads is the caller's real tailnet IP (100.64.x.y) and
-- cannot be forged by the client. Storing it per request is what answers "API key X
-- consumed from device Y"; the IP -> device-name mapping is resolved at read time
-- (tailnet IPs are stable per node in Headscale), so renaming a device in Headscale
-- relabels history instead of freezing an old name into every row.
--
-- NULL = request predates this column or arrived without a usable client IP.
ALTER TABLE usage_history ADD COLUMN client_ip TEXT;
CREATE INDEX IF NOT EXISTS idx_usage_history_key_client_ip
  ON usage_history (api_key_id, client_ip, timestamp);
