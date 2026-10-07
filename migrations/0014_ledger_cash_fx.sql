-- CapitalOS — cash, currencies and FX
--
-- The ledger knew only buys and sells, all implicitly in US dollars. A real
-- account also has deposits, withdrawals, dividends, interest and fees, and a
-- Canadian account holds CAD and USD side by side. Every money amount now
-- carries its currency, accounts have a base currency to report in, and FX
-- rates are stored by date so a valuation can be reproduced for any day.

-- The listing currency of each security; prices and trade prices are in it.
ALTER TABLE companies ADD COLUMN currency CHAR(3) NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$');

ALTER TABLE transactions ADD COLUMN currency CHAR(3) NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$');

-- An account that records its cash (deposits and withdrawals) is valued as
-- positions plus cash, and its returns are measured against those flows. One
-- that does not is valued as positions alone, with each trade's cash treated
-- as money put in or taken out — how the desk worked before.
ALTER TABLE accounts ADD COLUMN tracks_cash BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE cash_movements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id),
  kind TEXT NOT NULL CHECK (kind IN ('deposit', 'withdrawal', 'dividend', 'interest', 'fee', 'tax')),
  -- always positive; the kind says which way the money moved
  amount NUMERIC(18,4) NOT NULL CHECK (amount > 0),
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  occurred_at TIMESTAMPTZ NOT NULL,
  company_id UUID REFERENCES companies(id),
  note TEXT CHECK (note IS NULL OR length(note) <= 500),
  idempotency_key TEXT CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 8 AND 128),
  external_id TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  voided_at TIMESTAMPTZ,
  voided_by UUID REFERENCES users(id) ON DELETE SET NULL,
  void_reason TEXT CHECK (void_reason IS NULL OR length(void_reason) <= 500),
  CONSTRAINT cash_void_complete CHECK ((voided_at IS NULL) = (void_reason IS NULL)),
  CONSTRAINT cash_dividend_has_company CHECK (kind <> 'dividend' OR company_id IS NOT NULL)
);
CREATE UNIQUE INDEX cash_movements_idempotency ON cash_movements (account_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX cash_movements_timeline ON cash_movements (account_id, occurred_at) WHERE voided_at IS NULL;

-- Units of `quote` per one unit of `base` on `date`.
CREATE TABLE fx_rates (
  base CHAR(3) NOT NULL,
  quote CHAR(3) NOT NULL,
  date DATE NOT NULL,
  rate NUMERIC(18,8) NOT NULL CHECK (rate > 0),
  source TEXT NOT NULL,
  PRIMARY KEY (base, quote, date)
);

-- Whether a stored dividend amount is per share as paid, or restated for
-- later splits (Yahoo's are; Alpaca's are as paid).
ALTER TABLE dividends ADD COLUMN basis TEXT NOT NULL DEFAULT 'as_paid' CHECK (basis IN ('as_paid', 'split_adjusted'));
UPDATE dividends SET basis = 'split_adjusted' WHERE source = 'yahoo';
