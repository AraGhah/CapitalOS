-- CapitalOS — outside signals, as fetched
--
-- StockTwits sentiment counts and Polymarket odds change by the minute and
-- cannot be fetched for a past date. The committee reads them into its evidence
-- pack, and the pack is hashed to decide whether a run can be reused; a signal
-- fetched afresh for every run would make every run a new one. A snapshot is
-- reused for SIGNAL_TTL_MINUTES, which also keeps a dated record of what the
-- feed said, since it can never be asked again.

CREATE TABLE signal_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL CHECK (length(source) BETWEEN 1 AND 40),
  -- a ticker for a per-company feed, the search topic for a topic feed
  key TEXT NOT NULL CHECK (length(key) BETWEEN 1 AND 200),
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload JSONB NOT NULL
);

CREATE INDEX signal_snapshots_lookup_idx ON signal_snapshots (source, key, fetched_at DESC);
