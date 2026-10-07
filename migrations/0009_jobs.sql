-- CapitalOS — durable background jobs
--
-- Long work (a committee is a dozen model calls over several minutes, an
-- autopilot pass can convene several) runs in a worker process, not inside an
-- HTTP request. A request enqueues a job and returns its id; the worker claims
-- it with FOR UPDATE SKIP LOCKED, holds a lease it renews while working, and
-- records every progress event, which the page follows over server-sent events.
--
-- A worker that dies loses its lease; the job goes back to the queue (or to
-- the dead-letter state once its attempts are spent), so nothing stays
-- "running" forever and nothing is silently dropped.

CREATE TABLE jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'dead')),
  priority INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts >= 1),
  run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- the same logical job is never queued twice while one is pending
  dedupe_key TEXT,
  locked_by TEXT,
  locked_until TIMESTAMPTZ,
  result JSONB,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX jobs_pending_dedupe ON jobs (kind, dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'running');
CREATE INDEX jobs_ready ON jobs (priority DESC, run_at) WHERE status = 'queued';
CREATE INDEX jobs_leases ON jobs (locked_until) WHERE status = 'running';
CREATE INDEX jobs_user ON jobs (user_id, created_at DESC);

CREATE TABLE job_events (
  id BIGSERIAL PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  event JSONB NOT NULL
);
CREATE INDEX job_events_job ON job_events (job_id, id);

-- A scheduled task runs once per time slot however many workers are up: the
-- first worker to insert the slot's row is the one that enqueues it.
CREATE TABLE schedule_slots (
  name TEXT NOT NULL,
  slot TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (name, slot)
);

-- The worker heartbeat, for /api/ready and for the page to say whether
-- queued work will actually be picked up.
CREATE TABLE workers (
  id TEXT PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  kinds TEXT[] NOT NULL,
  host TEXT
);
