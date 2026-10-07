-- CapitalOS — shared rate limits
--
-- A token bucket per key, in the database, so every process (web servers,
-- workers, the MCP server, scripts) draws from the same allowance: SEC's ten
-- requests a second, GDELT's one every few seconds, each model provider's
-- per-minute limit, and each person's write rate on the API. Kept UNLOGGED:
-- it is a counter, and losing it in a crash only resets the buckets to full.

CREATE UNLOGGED TABLE rate_limits (
  key TEXT PRIMARY KEY,
  tokens DOUBLE PRECISION NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
