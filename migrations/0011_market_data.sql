-- CapitalOS — market-data provenance and dividends
--
-- Every stored bar says which provider it came from, so a figure computed from
-- unlicensed development data can be told apart from licensed data.
--
-- adj_close used to be written as a copy of close, which made the name a lie.
-- Closes are split-adjusted and not dividend-adjusted; adj_close is cleared
-- and stays NULL until a provider supplies a true total-return series.
-- Dividends are stored as events instead, which is what a ledger needs anyway.

ALTER TABLE prices_daily ADD COLUMN source TEXT;
UPDATE prices_daily SET adj_close = NULL;
COMMENT ON COLUMN prices_daily.close IS 'split-adjusted close, not adjusted for dividends';
COMMENT ON COLUMN prices_daily.adj_close IS 'dividend-and-split-adjusted close when a provider supplies one; otherwise NULL';

-- The prices_daily_company_id_date_idx index duplicated the primary key.
DROP INDEX IF EXISTS prices_daily_company_id_date_idx;

CREATE TABLE dividends (
  company_id UUID NOT NULL REFERENCES companies(id),
  ex_date DATE NOT NULL,
  pay_date DATE,
  -- cash per share on the share count of the ex-date
  amount NUMERIC(18,8) NOT NULL CHECK (amount > 0),
  currency CHAR(3) NOT NULL DEFAULT 'USD',
  source TEXT NOT NULL,
  PRIMARY KEY (company_id, ex_date)
);
