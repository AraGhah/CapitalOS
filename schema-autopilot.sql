-- CapitalOS — the autopilot
--
-- Apply with `npm run migrate` (every layer) or `npm run migrate-autopilot`.
-- IF NOT EXISTS throughout.
--
-- An alert is written by code that crossed a threshold, never by a model. The
-- dedupe key makes each event alert once however often the loop runs: the same
-- 6% drop on the same day is one alert, not one per cycle.

CREATE TABLE IF NOT EXISTS alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  company_id UUID REFERENCES companies(id),
  kind TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warn', 'high')),
  title TEXT NOT NULL,
  detail TEXT,
  dedupe_key TEXT NOT NULL UNIQUE,
  -- the portfolio consequence, computed when the alert concerns a held position
  impact JSONB,
  -- the committee the autopilot convened in response, when it did
  run_id UUID REFERENCES consensus_runs(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'seen', 'dismissed'))
);

CREATE INDEX IF NOT EXISTS alerts_recent ON alerts (created_at DESC);
CREATE INDEX IF NOT EXISTS alerts_open ON alerts (status) WHERE status = 'new';

-- One row per pass of the loop: what it looked at, what it found, what it did.
CREATE TABLE IF NOT EXISTS autopilot_runs (
  id BIGSERIAL PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  summary JSONB,
  error TEXT
);

CREATE INDEX IF NOT EXISTS autopilot_runs_recent ON autopilot_runs (started_at DESC);
