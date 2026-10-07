-- CapitalOS — the consensus layer
--
-- Same rule as the desk layer: everything a model writes lives here, and every
-- model call is kept with its token count, latency and price, so a conclusion
-- can be traced to the exact calls, claims and evidence behind it — and so the
-- models themselves can be graded on what they got right.

-- One row per committee convened. `evidence` is the exact pack every model read,
-- frozen at the time of the run, so the report can always be re-checked against
-- what the models were actually shown rather than against today's data.
CREATE TABLE IF NOT EXISTS consensus_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  mode TEXT NOT NULL CHECK (mode IN ('fast', 'standard', 'deep', 'committee')),
  focus TEXT,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'failed')),
  error TEXT,
  evidence_hash TEXT NOT NULL,
  -- digest of the evidence, the mode, the focus and the model line-up: an
  -- identical committee on identical evidence is served from here, not re-billed
  cache_key TEXT NOT NULL,
  evidence JSONB NOT NULL,
  models JSONB NOT NULL DEFAULT '[]'::jsonb,
  report JSONB,
  confidence NUMERIC CHECK (confidence >= 0 AND confidence <= 1),
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd NUMERIC
);

CREATE INDEX IF NOT EXISTS consensus_runs_company ON consensus_runs (company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS consensus_runs_cache ON consensus_runs (cache_key) WHERE status = 'done';

-- One row per model call: the metered ledger. Nothing is billed that is not
-- written here first, and a failed call is kept with its error rather than lost.
CREATE TABLE IF NOT EXISTS model_calls (
  id BIGSERIAL PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES consensus_runs(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  stage TEXT NOT NULL,
  agent TEXT NOT NULL,
  model_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  output JSONB,
  raw_text TEXT,
  error TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  cost_usd NUMERIC
);

CREATE INDEX IF NOT EXISTS model_calls_run ON model_calls (run_id);
CREATE INDEX IF NOT EXISTS model_calls_model ON model_calls (model_id, stage);

-- Every factual claim a model made during a run, and what the checker found.
-- method says whether code or a model did the checking, since only one of those
-- is reproducible.
CREATE TABLE IF NOT EXISTS claim_checks (
  id BIGSERIAL PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES consensus_runs(id) ON DELETE CASCADE,
  call_id BIGINT REFERENCES model_calls(id) ON DELETE CASCADE,
  claim_key TEXT NOT NULL,
  claim TEXT NOT NULL,
  evidence_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  verdict TEXT NOT NULL CHECK (verdict IN
    ('verified', 'sourced', 'miscited', 'unsupported', 'contradicted', 'unsourced')),
  method TEXT NOT NULL CHECK (method IN ('code', 'model')),
  reason TEXT,
  judge TEXT CHECK (judge IN ('accept', 'weak', 'reject'))
);

CREATE INDEX IF NOT EXISTS claim_checks_run ON claim_checks (run_id);

-- How each model did on each stage of each run. `scores` holds the criteria
-- (accuracy and evidence from the checker; logic, completeness and the rest from
-- the judge), `overall` is their mean. The router reads this to decide which
-- model gets which job next time.
CREATE TABLE IF NOT EXISTS model_evaluations (
  id BIGSERIAL PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES consensus_runs(id) ON DELETE CASCADE,
  call_id BIGINT REFERENCES model_calls(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  model_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  scores JSONB NOT NULL,
  overall NUMERIC CHECK (overall >= 0 AND overall <= 1)
);

CREATE INDEX IF NOT EXISTS model_evaluations_model ON model_evaluations (model_id, stage);

-- Assumptions a committee made that a future filing can settle. Each carries a
-- structured rule over a stored metric and the period it was made against, so
-- checking it is arithmetic on a newer period, never a model's opinion of itself.
CREATE TABLE IF NOT EXISTS ai_memory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  run_id UUID REFERENCES consensus_runs(id) ON DELETE SET NULL,
  -- the model that wrote it, so the record of which models' assumptions held
  -- can be kept per model
  model_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind TEXT NOT NULL CHECK (kind IN ('assumption', 'invalidation')),
  statement TEXT NOT NULL,
  metric TEXT,
  operator TEXT CHECK (operator IN ('<', '>', '<=', '>=')),
  value NUMERIC,
  -- the latest annual period in the evidence when the assumption was made; only
  -- a later period can confirm or refute it
  baseline_period DATE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'supported', 'refuted', 'untestable')),
  checked_at TIMESTAMPTZ,
  checked_period DATE,
  actual NUMERIC
);

CREATE INDEX IF NOT EXISTS ai_memory_company ON ai_memory (company_id, created_at DESC);

-- The decision journal: one line per thing that happened to a company on this
-- desk, written by the code paths that did it.
CREATE TABLE IF NOT EXISTS decision_journal (
  id BIGSERIAL PRIMARY KEY,
  company_id UUID REFERENCES companies(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT,
  ref_id TEXT
);

CREATE INDEX IF NOT EXISTS decision_journal_recent ON decision_journal (created_at DESC);
CREATE INDEX IF NOT EXISTS decision_journal_company ON decision_journal (company_id, created_at DESC);
