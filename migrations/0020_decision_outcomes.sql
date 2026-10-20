-- CapitalOS — how recorded decisions turned out
--
-- A recorded decision keeps the price it was drawn at (decisions.ref_price,
-- price_as_of). Once enough sessions have passed, lib/track measures what the
-- stock did next, less what the S&P 500 did over the same sessions, and writes
-- the result here, once per decision and horizon. The measuring is arithmetic
-- on stored closes; no model is asked.
--
-- An outcome is a record of what happened and is never rewritten: a later price
-- revision or a change to the grading rules does not change what was written
-- the day the horizon closed. The database refuses an UPDATE. A decision that
-- cannot be fairly measured (a split fell inside the window, the stored prices
-- have a hole in them) is recorded as `excluded` with the reason, so it is not
-- retried every night and the page can say why it is missing.
--
-- Like decisions, outcomes are not trimmed by retention.

CREATE TABLE decision_outcomes (
  decision_id UUID NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  -- sessions after the decision's price date
  horizon INTEGER NOT NULL CHECK (horizon > 0),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id),
  settled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- right / wrong: the rating's direction against the market, past a band that grows with the horizon
  -- flat:          inside that band
  -- no_claim:      a hold, which does not say the stock will do better or worse than the market
  -- excluded:      not fairly measurable; `reason` says why
  verdict TEXT NOT NULL CHECK (verdict IN ('right', 'wrong', 'flat', 'no_claim', 'excluded')),
  reason TEXT,
  entry_date DATE,
  entry_close NUMERIC CHECK (entry_close IS NULL OR entry_close > 0),
  exit_date DATE,
  exit_close NUMERIC CHECK (exit_close IS NULL OR exit_close > 0),
  stock_return NUMERIC,
  market_return NUMERIC,
  -- stock_return - market_return
  alpha NUMERIC,
  -- how the plan's entry, stop and reward levels fared over the same sessions; null when the decision had no entry plan
  path JSONB,
  PRIMARY KEY (decision_id, horizon),
  CHECK ((verdict = 'excluded') = (reason IS NOT NULL)),
  CHECK (verdict = 'excluded' OR (entry_date IS NOT NULL AND exit_date IS NOT NULL AND alpha IS NOT NULL))
);

CREATE INDEX decision_outcomes_user ON decision_outcomes (user_id, settled_at DESC);
CREATE INDEX decision_outcomes_company ON decision_outcomes (user_id, company_id, settled_at DESC);

CREATE FUNCTION decision_outcomes_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'decision_outcomes is a record of what happened and is not updated';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER decision_outcomes_no_update BEFORE UPDATE ON decision_outcomes
  FOR EACH ROW EXECUTE FUNCTION decision_outcomes_immutable();
