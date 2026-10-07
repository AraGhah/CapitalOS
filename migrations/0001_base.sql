-- CapitalOS — the base schema (formerly schema.sql).
-- IF NOT EXISTS throughout, so a database created from the old hand-applied
-- schema.sql takes this migration as a no-op and is adopted as-is.

CREATE TABLE IF NOT EXISTS companies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker TEXT NOT NULL UNIQUE,
  cik TEXT,
  name TEXT NOT NULL,
  sector TEXT,
  industry TEXT,
  active BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS prices_daily (
  company_id UUID NOT NULL REFERENCES companies(id),
  date DATE NOT NULL,
  open NUMERIC(12,4),
  high NUMERIC(12,4),
  low NUMERIC(12,4),
  close NUMERIC(12,4),
  volume BIGINT,
  adj_close NUMERIC(12,4),
  PRIMARY KEY (company_id, date)
);

CREATE TABLE IF NOT EXISTS filings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  accession TEXT NOT NULL UNIQUE,
  form_type TEXT NOT NULL,
  filed_at DATE NOT NULL,
  period_end DATE,
  url TEXT
);

-- append only: a restatement is a new row, never an update on an existing one
CREATE TABLE IF NOT EXISTS fundamentals (
  id BIGSERIAL PRIMARY KEY,
  company_id UUID NOT NULL REFERENCES companies(id),
  period_end DATE NOT NULL,
  fiscal_period TEXT NOT NULL,
  metric TEXT NOT NULL,
  value NUMERIC,
  filing_id UUID REFERENCES filings(id),
  retrieved_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS macro_series (
  series_id TEXT NOT NULL,
  date DATE NOT NULL,
  value NUMERIC,
  PRIMARY KEY (series_id, date)
);

CREATE TABLE IF NOT EXISTS sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT,
  published_at TIMESTAMPTZ,
  retrieved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw_hash TEXT,
  embedding JSONB
);

-- every claim written here needs a source and a verbatim snippet, not just a summary
CREATE TABLE IF NOT EXISTS research_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  field TEXT NOT NULL,
  claim TEXT NOT NULL,
  source_id UUID NOT NULL REFERENCES sources(id),
  snippet TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scores (
  company_id UUID NOT NULL REFERENCES companies(id),
  as_of DATE NOT NULL,
  component TEXT NOT NULL,
  raw_value NUMERIC,
  percentile NUMERIC,
  weight NUMERIC,
  PRIMARY KEY (company_id, as_of, component)
);

CREATE TABLE IF NOT EXISTS transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL,
  company_id UUID NOT NULL REFERENCES companies(id),
  side TEXT NOT NULL CHECK (side IN ('buy','sell')),
  qty NUMERIC(14,4) NOT NULL,
  price NUMERIC(12,4) NOT NULL,
  fees NUMERIC(10,4) NOT NULL DEFAULT 0,
  executed_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS theses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  rationale TEXT,
  invalidation_rules JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','invalidated','closed'))
);

CREATE TABLE IF NOT EXISTS watchlist (
  company_id UUID NOT NULL REFERENCES companies(id),
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  note TEXT,
  PRIMARY KEY (company_id)
);

CREATE INDEX IF NOT EXISTS fundamentals_company_id_metric_period_end_idx ON fundamentals (company_id, metric, period_end);
CREATE INDEX IF NOT EXISTS prices_daily_company_id_date_idx ON prices_daily (company_id, date);

-- One row per story, not per article: near-identical coverage of the same news
-- collapses into a single event whose weight is its source count.
CREATE TABLE IF NOT EXISTS events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  canonical_source_id UUID NOT NULL REFERENCES sources(id),
  title TEXT NOT NULL,
  first_seen TIMESTAMPTZ NOT NULL,
  last_seen TIMESTAMPTZ NOT NULL,
  source_count INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS event_sources (
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  source_id UUID NOT NULL REFERENCES sources(id),
  PRIMARY KEY (event_id, source_id)
);

CREATE INDEX IF NOT EXISTS events_company_id_first_seen_idx ON events (company_id, first_seen);
