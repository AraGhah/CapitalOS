-- CapitalOS — the investor behind the desk
--
-- A stock can be an excellent business and still be the wrong investment for
-- the person buying it. The pre-investment checklist (lib/checklist.ts) asks
-- about the person first — emergency savings, expensive debt, when the money
-- is needed, how much of it could be lost — and those answers live here, one
-- row per person. Every column is nullable: an unanswered question is shown as
-- unanswered, never filled with a default that would pass a check.

CREATE TABLE investor_profiles (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- in the account's base currency
  monthly_expenses NUMERIC(18,2) CHECK (monthly_expenses IS NULL OR monthly_expenses >= 0),
  emergency_fund NUMERIC(18,2) CHECK (emergency_fund IS NULL OR emergency_fund >= 0),
  high_interest_debt NUMERIC(18,2) CHECK (high_interest_debt IS NULL OR high_interest_debt >= 0),
  investable_amount NUMERIC(18,2) CHECK (investable_amount IS NULL OR investable_amount >= 0),
  position_size NUMERIC(18,2) CHECK (position_size IS NULL OR position_size >= 0),
  objective TEXT CHECK (objective IS NULL OR objective IN ('emergency', 'car', 'house', 'wealth', 'retirement', 'income')),
  horizon_years NUMERIC(5,1) CHECK (horizon_years IS NULL OR horizon_years >= 0),
  -- the share of the invested money that could be lost without jeopardising
  -- the goal (risk capacity), and how a fall would feel (risk tolerance)
  max_loss_share NUMERIC(5,4) CHECK (max_loss_share IS NULL OR max_loss_share BETWEEN 0 AND 1),
  risk_tolerance TEXT CHECK (risk_tolerance IS NULL OR risk_tolerance IN ('low', 'medium', 'high')),
  account_type TEXT CHECK (account_type IS NULL OR account_type IN ('tfsa', 'rrsp', 'fhsa', 'non_registered', 'other')),
  contribution_room NUMERIC(18,2) CHECK (contribution_room IS NULL OR contribution_room >= 0),
  -- commission plus currency conversion, as a share of the trade
  trading_cost_share NUMERIC(6,5) CHECK (trading_cost_share IS NULL OR trading_cost_share BETWEEN 0 AND 1),
  institution TEXT CHECK (institution IS NULL OR length(institution) <= 120),
  -- the person checked the firm on the CSA / CIRO registration search
  institution_verified BOOLEAN,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
