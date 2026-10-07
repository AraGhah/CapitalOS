-- CapitalOS — the research desk layer
--
-- Everything a model writes lives in these tables and nowhere else. The
-- deterministic side of the app -- fundamentals, scores, research_notes -- is
-- untouched by them, so a verdict can never be mistaken for a reported figure.
-- Each headline keeps its sources row, so any dossier is traceable to the exact
-- set of headlines it was drawn from.

-- One row per headline per company, from whichever feed found it.
CREATE TABLE IF NOT EXISTS headlines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  source_id UUID NOT NULL REFERENCES sources(id),
  feed TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  domain TEXT,
  published_at TIMESTAMPTZ,
  retrieved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- written by the analyst, null until it has read this headline
  sentiment TEXT CHECK (sentiment IN ('bullish', 'neutral', 'bearish')),
  sentiment_provider TEXT,
  tagged_at TIMESTAMPTZ,
  UNIQUE (company_id, url)
);

CREATE INDEX IF NOT EXISTS headlines_company_published
  ON headlines (company_id, published_at DESC);

-- One row per pipeline run. input_hash is a digest of the exact headline set the
-- strategist read, so an unchanged company is never re-analysed and every
-- verdict names the evidence behind it.
CREATE TABLE IF NOT EXISTS dossiers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  input_hash TEXT NOT NULL,
  headline_count INTEGER NOT NULL DEFAULT 0,
  verdict TEXT NOT NULL CHECK (verdict IN ('BUY', 'ACCUMULATE', 'HOLD', 'WAIT', 'AVOID')),
  confidence NUMERIC CHECK (confidence >= 0 AND confidence <= 1),
  risk TEXT CHECK (risk IN ('low', 'medium', 'high')),
  horizon TEXT,
  brief_headline TEXT,
  brief_summary TEXT,
  entry_plan TEXT,
  bull JSONB NOT NULL DEFAULT '[]'::jsonb,
  bear JSONB NOT NULL DEFAULT '[]'::jsonb,
  catalysts JSONB NOT NULL DEFAULT '[]'::jsonb,
  sentiment JSONB NOT NULL DEFAULT '{}'::jsonb,
  feeds JSONB NOT NULL DEFAULT '[]'::jsonb,
  provider TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS dossiers_cache_key
  ON dossiers (company_id, input_hash);

CREATE INDEX IF NOT EXISTS dossiers_latest
  ON dossiers (company_id, created_at DESC);

-- Which headlines a given dossier actually read.
CREATE TABLE IF NOT EXISTS dossier_headlines (
  dossier_id UUID NOT NULL REFERENCES dossiers(id) ON DELETE CASCADE,
  headline_id UUID NOT NULL REFERENCES headlines(id) ON DELETE CASCADE,
  PRIMARY KEY (dossier_id, headline_id)
);

-- The chat transcript, so a refresh does not lose the conversation. tool_calls
-- records what the assistant actually fetched, which is the only reason to
-- believe an answer it gives.
CREATE TABLE IF NOT EXISTS chat_messages (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  tool_calls JSONB NOT NULL DEFAULT '[]'::jsonb
);

CREATE INDEX IF NOT EXISTS chat_messages_recent ON chat_messages (created_at DESC);
