-- CapitalOS — integrity constraints and stock splits
--
-- Apply with `npm run migrate` (every layer) or `npm run migrate schema-hardening.sql`.
-- Safe to run again: every statement checks before it creates.

-- Splits, so ledger quantities recorded before a split can be compared with
-- split-adjusted prices. Filled by fetch-prices-yahoo and fetch-prices.
CREATE TABLE IF NOT EXISTS splits (
  company_id UUID NOT NULL REFERENCES companies(id),
  date DATE NOT NULL,
  ratio NUMERIC NOT NULL CHECK (ratio > 0),
  PRIMARY KEY (company_id, date)
);

-- A model run that has been granted a slot of a daily budget but has not
-- written its result yet. Counting these alongside the finished runs is what
-- stops two runs started together from both taking the last slot. A row older
-- than its expiry belongs to a run that died and no longer counts.
CREATE TABLE IF NOT EXISTS budget_reservations (
  id BIGSERIAL PRIMARY KEY,
  kind TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The ledger refuses rows no trade could produce. NOT VALID applies the checks
-- to every new row without failing on rows written before they existed; run
-- `ALTER TABLE transactions VALIDATE CONSTRAINT ...` once those are cleaned up.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transactions_qty_positive') THEN
    ALTER TABLE transactions ADD CONSTRAINT transactions_qty_positive CHECK (qty > 0) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transactions_price_positive') THEN
    ALTER TABLE transactions ADD CONSTRAINT transactions_price_positive CHECK (price > 0) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transactions_fees_nonnegative') THEN
    ALTER TABLE transactions ADD CONSTRAINT transactions_fees_nonnegative CHECK (fees >= 0) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'paper_trades_fees_nonnegative') THEN
    ALTER TABLE paper_trades ADD CONSTRAINT paper_trades_fees_nonnegative CHECK (fees >= 0) NOT VALID;
  END IF;
END $$;
