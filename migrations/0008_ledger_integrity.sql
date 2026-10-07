-- CapitalOS — ledger integrity
--
-- A transaction is never edited or deleted. A mistake is voided (kept, marked,
-- with who and why), and every write to the ledger leaves an audit row in the
-- same database transaction as the write itself.
--
-- An idempotency key makes a retried or double-clicked submission a no-op
-- instead of a second trade.

ALTER TABLE transactions
  ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN idempotency_key TEXT CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 8 AND 128),
  ADD COLUMN note TEXT CHECK (note IS NULL OR length(note) <= 500),
  ADD COLUMN voided_at TIMESTAMPTZ,
  ADD COLUMN voided_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN void_reason TEXT CHECK (void_reason IS NULL OR length(void_reason) <= 500),
  ADD CONSTRAINT transactions_void_complete CHECK ((voided_at IS NULL) = (void_reason IS NULL));

CREATE UNIQUE INDEX transactions_idempotency
  ON transactions (account_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- The ledger replay reads one position at a time, in time order.
CREATE INDEX transactions_position_timeline
  ON transactions (account_id, company_id, executed_at) WHERE voided_at IS NULL;

CREATE TABLE audit_log (
  id BIGSERIAL PRIMARY KEY,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT,
  request_id TEXT,
  ip TEXT,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX audit_log_user ON audit_log (user_id, at DESC);
CREATE INDEX audit_log_entity ON audit_log (entity, entity_id);
