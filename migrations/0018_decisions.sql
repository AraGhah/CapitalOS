-- CapitalOS — decisions, as recorded
--
-- A committee report says how a stock looks. A decision says what to do about
-- it for one person on one day: a five-tier rating, an action, a plan and a
-- size (lib/decision). Computing one is free and repeatable, so nothing is
-- stored until the person records it. A recorded decision keeps the exact
-- inputs it was drawn from and the price it was drawn at, so it can be judged
-- against what the stock did next and never rewritten by a later change to the
-- rules.
--
-- Decisions are the record of what the desk advised and are not trimmed by
-- retention. Deleting the committee run they came from leaves them in place.

CREATE TABLE decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id),
  run_id UUID REFERENCES consensus_runs(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  rating TEXT NOT NULL CHECK (rating IN ('buy', 'overweight', 'hold', 'underweight', 'sell')),
  action TEXT NOT NULL CHECK (action IN ('buy', 'add', 'hold', 'trim', 'sell', 'watch', 'avoid')),
  -- the last close the plan was drawn from, in the stock's own currency
  ref_price NUMERIC CHECK (ref_price IS NULL OR ref_price > 0),
  price_as_of DATE,
  -- a digest of `inputs`: the same inputs are recorded once per run
  inputs_hash TEXT NOT NULL CHECK (length(inputs_hash) = 64),
  inputs JSONB NOT NULL,
  decision JSONB NOT NULL,
  UNIQUE (user_id, run_id, inputs_hash)
);

CREATE INDEX decisions_user_recent ON decisions (user_id, created_at DESC);
CREATE INDEX decisions_company ON decisions (user_id, company_id, created_at DESC);
