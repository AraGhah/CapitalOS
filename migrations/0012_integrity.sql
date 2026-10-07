-- CapitalOS — integrity constraints and missing indexes
--
-- Rules the application used to enforce only in memory become rules the
-- database enforces, so two processes racing cannot break them.

-- Tickers are stored upper-case, so a lookup can use the unique index
-- (ticker = upper($1)) instead of scanning on upper(ticker).
UPDATE companies c SET ticker = upper(c.ticker)
WHERE c.ticker <> upper(c.ticker)
  AND NOT EXISTS (SELECT 1 FROM companies d WHERE d.ticker = upper(c.ticker));
ALTER TABLE companies ADD CONSTRAINT companies_ticker_upper CHECK (ticker = upper(ticker)) NOT VALID;

-- One sources row per news URL. Duplicates written by concurrent scouts are
-- folded into the oldest row before the index is built.
WITH ranked AS (
  SELECT id, url, first_value(id) OVER (PARTITION BY url ORDER BY retrieved_at, id) AS keep
  FROM sources WHERE kind = 'news'
),
dupes AS (SELECT id, keep FROM ranked WHERE id <> keep)
UPDATE headlines h SET source_id = d.keep FROM dupes d WHERE h.source_id = d.id;

WITH ranked AS (
  SELECT id, url, first_value(id) OVER (PARTITION BY url ORDER BY retrieved_at, id) AS keep
  FROM sources WHERE kind = 'news'
),
dupes AS (SELECT id, keep FROM ranked WHERE id <> keep)
UPDATE research_notes r SET source_id = d.keep FROM dupes d WHERE r.source_id = d.id;

WITH ranked AS (
  SELECT id, url, first_value(id) OVER (PARTITION BY url ORDER BY retrieved_at, id) AS keep
  FROM sources WHERE kind = 'news'
),
dupes AS (SELECT id, keep FROM ranked WHERE id <> keep)
UPDATE events e SET canonical_source_id = d.keep FROM dupes d WHERE e.canonical_source_id = d.id;

WITH ranked AS (
  SELECT id, url, first_value(id) OVER (PARTITION BY url ORDER BY retrieved_at, id) AS keep
  FROM sources WHERE kind = 'news'
),
dupes AS (SELECT id, keep FROM ranked WHERE id <> keep)
INSERT INTO event_sources (event_id, source_id)
SELECT es.event_id, d.keep FROM event_sources es JOIN dupes d ON d.id = es.source_id
ON CONFLICT DO NOTHING;

WITH ranked AS (
  SELECT id, first_value(id) OVER (PARTITION BY url ORDER BY retrieved_at, id) AS keep
  FROM sources WHERE kind = 'news'
)
DELETE FROM event_sources es USING ranked r WHERE es.source_id = r.id AND r.id <> r.keep;

WITH ranked AS (
  SELECT id, first_value(id) OVER (PARTITION BY url ORDER BY retrieved_at, id) AS keep
  FROM sources WHERE kind = 'news'
)
DELETE FROM sources s USING ranked r WHERE s.id = r.id AND r.id <> r.keep;

CREATE UNIQUE INDEX sources_news_url ON sources (url) WHERE kind = 'news';

-- fundamentals is append-only, and an identical fact from the same filing is
-- one fact: duplicates from concurrent ingests are removed, then refused.
DELETE FROM fundamentals f USING fundamentals g
WHERE f.company_id = g.company_id AND f.metric = g.metric AND f.period_end = g.period_end
  AND f.fiscal_period = g.fiscal_period AND f.value IS NOT DISTINCT FROM g.value
  AND f.filing_id IS NOT DISTINCT FROM g.filing_id AND f.id > g.id;

CREATE UNIQUE INDEX fundamentals_fact ON fundamentals
  (company_id, metric, period_end, fiscal_period, COALESCE(filing_id, '00000000-0000-0000-0000-000000000000'::uuid), value);

-- Indexes the queries had been missing.
CREATE INDEX filings_company_filed ON filings (company_id, filed_at DESC);
CREATE INDEX headlines_untagged ON headlines (company_id, published_at DESC) WHERE sentiment IS NULL;
CREATE INDEX headlines_source ON headlines (source_id);
CREATE INDEX research_notes_source ON research_notes (source_id);
CREATE INDEX event_sources_source ON event_sources (source_id);
CREATE INDEX model_calls_created ON model_calls (created_at);
CREATE INDEX transactions_company ON transactions (company_id);

-- The ledger CHECKs added NOT VALID in 0006 are validated where existing rows
-- allow it. A row that breaks one is left in place (and reported) rather than
-- deleted by a migration: the constraint still applies to every new row.
DO $$
DECLARE
  c TEXT;
BEGIN
  FOREACH c IN ARRAY ARRAY['transactions_qty_positive', 'transactions_price_positive', 'transactions_fees_nonnegative'] LOOP
    BEGIN
      EXECUTE format('ALTER TABLE transactions VALIDATE CONSTRAINT %I', c);
    EXCEPTION WHEN check_violation THEN
      RAISE NOTICE 'constraint % left NOT VALID: existing rows break it; fix them and validate by hand', c;
    END;
  END LOOP;
  BEGIN
    ALTER TABLE paper_trades VALIDATE CONSTRAINT paper_trades_fees_nonnegative;
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'paper_trades_fees_nonnegative left NOT VALID';
  END;
  BEGIN
    ALTER TABLE companies VALIDATE CONSTRAINT companies_ticker_upper;
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'companies_ticker_upper left NOT VALID: a lower-case ticker collides with an upper-case one';
  END;
END $$;
