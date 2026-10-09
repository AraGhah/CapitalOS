-- CapitalOS — what each copilot answer was made with
--
-- An answer now records the models that produced it — the model identifier the
-- provider's response reported for the copilot's own calls, and the model_calls
-- log of any committee or research run a tool started — plus the follow-up
-- questions it suggested. Rows written before this column existed have '{}',
-- which the desk shows as "model information unavailable" rather than a guess.

ALTER TABLE chat_messages ADD COLUMN meta JSONB NOT NULL DEFAULT '{}'::jsonb;
