-- CapitalOS — identity, sessions and ownership
--
-- Until now the desk had one hard-coded account and one shared token. This
-- gives every row a person who owns it. Market data (companies, prices,
-- filings, fundamentals, headlines, sources, scores, macro) stays shared:
-- it is public information about companies, not about anyone's money.
--
-- Everything that existed before belongs to the legacy owner created here,
-- who has no password yet: the first sign-in claims the desk (or run
-- `npm run user -- set-password owner@capitalos.local`).

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL CHECK (email = btrim(email) AND position('@' IN email) > 1),
  -- scrypt$N$r$p$salt$hash; NULL until a password is set
  password_hash TEXT,
  display_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  disabled_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX users_email_unique ON users (lower(email));

-- The cookie carries a random token; only its SHA-256 is stored, so a leaked
-- table cannot be replayed as sessions.
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  user_agent TEXT,
  ip TEXT
);
CREATE INDEX sessions_user ON sessions (user_id);
CREATE INDEX sessions_expiry ON sessions (expires_at);

-- Failed and successful sign-ins, for throttling guesses per address and per IP.
CREATE TABLE login_attempts (
  id BIGSERIAL PRIMARY KEY,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  email TEXT NOT NULL,
  ip TEXT,
  success BOOLEAN NOT NULL
);
CREATE INDEX login_attempts_email ON login_attempts (lower(email), at DESC);
CREATE INDEX login_attempts_ip ON login_attempts (ip, at DESC);

CREATE TABLE accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'Main',
  base_currency CHAR(3) NOT NULL DEFAULT 'USD' CHECK (base_currency ~ '^[A-Z]{3}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX accounts_user ON accounts (user_id, created_at);

INSERT INTO users (id, email, display_name)
VALUES ('00000000-0000-0000-0000-000000000001', 'owner@capitalos.local', 'Owner');

INSERT INTO accounts (id, user_id, name)
VALUES ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'Main');

-- Any other account id already in the ledger becomes an account of the owner,
-- so the foreign key below holds for every existing row.
INSERT INTO accounts (id, user_id, name)
SELECT DISTINCT t.account_id, '00000000-0000-0000-0000-000000000001'::uuid, 'Imported'
FROM transactions t
WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id = t.account_id);

ALTER TABLE transactions
  ADD CONSTRAINT transactions_account_fk FOREIGN KEY (account_id) REFERENCES accounts(id);

-- An owner on every per-person table. No default: code that forgets to say
-- whose row it is writing fails loudly instead of writing it to the owner.
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'watchlist', 'theses', 'paper_trades', 'alerts', 'autopilot_runs', 'chat_messages',
    'decision_journal', 'consensus_runs', 'ai_memory', 'research_notes', 'budget_reservations'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN user_id UUID REFERENCES users(id) ON DELETE CASCADE', t);
    EXECUTE format('UPDATE %I SET user_id = %L', t, '00000000-0000-0000-0000-000000000001');
    EXECUTE format('ALTER TABLE %I ALTER COLUMN user_id SET NOT NULL', t);
  END LOOP;
END $$;

-- Dossiers summarise public news and stay shared, but each records who asked
-- for it, which is what a per-person daily budget counts.
ALTER TABLE dossiers ADD COLUMN requested_by UUID REFERENCES users(id) ON DELETE SET NULL;
UPDATE dossiers SET requested_by = '00000000-0000-0000-0000-000000000001';

-- One watchlist per person.
ALTER TABLE watchlist DROP CONSTRAINT watchlist_pkey;
ALTER TABLE watchlist ADD PRIMARY KEY (user_id, company_id);

-- An alert fires once per person, not once for the whole server.
ALTER TABLE alerts DROP CONSTRAINT alerts_dedupe_key_key;
CREATE UNIQUE INDEX alerts_user_dedupe ON alerts (user_id, dedupe_key);

CREATE INDEX theses_user_status ON theses (user_id, status);
CREATE INDEX paper_trades_user ON paper_trades (user_id, created_at);
CREATE INDEX alerts_user_recent ON alerts (user_id, status, created_at DESC);
CREATE INDEX autopilot_runs_user ON autopilot_runs (user_id, started_at DESC);
CREATE INDEX chat_messages_user ON chat_messages (user_id, id DESC);
CREATE INDEX decision_journal_user ON decision_journal (user_id, created_at DESC);
CREATE INDEX consensus_runs_user ON consensus_runs (user_id, created_at DESC);
CREATE INDEX ai_memory_user ON ai_memory (user_id, created_at DESC);
CREATE INDEX research_notes_user_company ON research_notes (user_id, company_id);
CREATE INDEX budget_reservations_user ON budget_reservations (user_id, kind, created_at);
CREATE INDEX dossiers_requested_by ON dossiers (requested_by, created_at);
