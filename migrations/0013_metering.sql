-- CapitalOS — every model call metered, in dollars, per person
--
-- model_calls held only committee calls. The copilot, the analyst's headline
-- tagging, the strategist and the market brief called models without leaving
-- a row, so neither their cost nor their failures were visible, and no budget
-- could be expressed in dollars. Now every call is a row, tied to the person
-- who caused it, and a run id only when it belongs to a committee.

ALTER TABLE model_calls ALTER COLUMN run_id DROP NOT NULL;
ALTER TABLE model_calls ADD COLUMN user_id UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE model_calls ADD COLUMN purpose TEXT NOT NULL DEFAULT 'committee';
ALTER TABLE model_calls ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0;
-- true when cost_usd came from the configured fallback rate, not a listed price
ALTER TABLE model_calls ADD COLUMN cost_estimated BOOLEAN NOT NULL DEFAULT false;

UPDATE model_calls m SET user_id = r.user_id FROM consensus_runs r WHERE r.id = m.run_id;

CREATE INDEX model_calls_user_spend ON model_calls (user_id, created_at);
