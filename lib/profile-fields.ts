// The investor profile's fixed choices, without the database, so the profile
// form, the request schemas and the checklist can all import them.

export const OBJECTIVES = ["emergency", "car", "house", "wealth", "retirement", "income"] as const;
export const RISK_TOLERANCES = ["low", "medium", "high"] as const;
export const ACCOUNT_TYPES = ["tfsa", "rrsp", "fhsa", "non_registered", "other"] as const;

export type Objective = (typeof OBJECTIVES)[number];
export type RiskTolerance = (typeof RISK_TOLERANCES)[number];
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export interface InvestorProfile {
  monthlyExpenses: number | null;
  emergencyFund: number | null;
  highInterestDebt: number | null;
  investableAmount: number | null;
  positionSize: number | null;
  objective: Objective | null;
  horizonYears: number | null;
  maxLossShare: number | null;
  riskTolerance: RiskTolerance | null;
  accountType: AccountType | null;
  contributionRoom: number | null;
  tradingCostShare: number | null;
  institution: string | null;
  institutionVerified: boolean | null;
  updatedAt: string | null;
}

export const EMPTY_PROFILE: InvestorProfile = {
  monthlyExpenses: null,
  emergencyFund: null,
  highInterestDebt: null,
  investableAmount: null,
  positionSize: null,
  objective: null,
  horizonYears: null,
  maxLossShare: null,
  riskTolerance: null,
  accountType: null,
  contributionRoom: null,
  tradingCostShare: null,
  institution: null,
  institutionVerified: null,
  updatedAt: null,
};
