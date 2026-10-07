-- CapitalOS — the strategy lab
--
-- Paper trades live apart from the real ledger in `transactions`, so a
-- simulation can never be mistaken for money that moved. Each one records the
-- SPY price at the moment it was placed: the benchmark for a paper portfolio is
-- the same dollars put into SPY on the same days, not SPY from an arbitrary date.

CREATE TABLE IF NOT EXISTS paper_trades (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  company_id UUID NOT NULL REFERENCES companies(id),
  side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  qty NUMERIC(18,6) NOT NULL CHECK (qty > 0),
  price NUMERIC(14,4) NOT NULL CHECK (price > 0),
  fees NUMERIC(10,4) NOT NULL DEFAULT 0,
  spy_price NUMERIC(14,4),
  -- the committee whose conclusion this trade tests, when there was one
  run_id UUID REFERENCES consensus_runs(id) ON DELETE SET NULL,
  rationale TEXT
);

CREATE INDEX IF NOT EXISTS paper_trades_recent ON paper_trades (created_at DESC);
