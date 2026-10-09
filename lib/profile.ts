import { pool } from "./db";
import { audit } from "./audit";
import type { Actor } from "./actor";
import { EMPTY_PROFILE, type InvestorProfile } from "./profile-fields";

export * from "./profile-fields";

/* ---------------------------------------------------------------------------
   The investor profile: the person's own finances and plans, which the
   pre-investment checklist reads before it says anything about a stock.
   Nothing here is inferred; a field the person has not filled in is null and
   the checklist reports it as a question still to answer.
--------------------------------------------------------------------------- */

// camelCase field → column, in one place so the read and the write agree
const COLUMNS: Record<Exclude<keyof InvestorProfile, "updatedAt">, string> = {
  monthlyExpenses: "monthly_expenses",
  emergencyFund: "emergency_fund",
  highInterestDebt: "high_interest_debt",
  investableAmount: "investable_amount",
  positionSize: "position_size",
  objective: "objective",
  horizonYears: "horizon_years",
  maxLossShare: "max_loss_share",
  riskTolerance: "risk_tolerance",
  accountType: "account_type",
  contributionRoom: "contribution_room",
  tradingCostShare: "trading_cost_share",
  institution: "institution",
  institutionVerified: "institution_verified",
};

const NUMERIC = new Set([
  "monthlyExpenses",
  "emergencyFund",
  "highInterestDebt",
  "investableAmount",
  "positionSize",
  "horizonYears",
  "maxLossShare",
  "contributionRoom",
  "tradingCostShare",
]);

export type ProfilePatch = Partial<Omit<InvestorProfile, "updatedAt">>;

export async function getProfile(userId: string): Promise<InvestorProfile> {
  const { rows } = await pool.query(`SELECT * FROM investor_profiles WHERE user_id = $1`, [userId]);
  const row = rows[0];
  if (!row) return { ...EMPTY_PROFILE };

  const out: InvestorProfile = { ...EMPTY_PROFILE, updatedAt: (row.updated_at as Date).toISOString() };
  for (const [field, column] of Object.entries(COLUMNS) as Array<[keyof typeof COLUMNS, string]>) {
    const value = row[column];
    (out as unknown as Record<string, unknown>)[field] =
      value === null || value === undefined ? null : NUMERIC.has(field) ? Number(value) : value;
  }
  return out;
}

// A patch sets the fields it names — null clears one — and leaves the rest.
export async function saveProfile(actor: Actor, patch: ProfilePatch): Promise<InvestorProfile> {
  const fields = (Object.keys(patch) as Array<keyof ProfilePatch>).filter((f) => f in COLUMNS);
  if (fields.length > 0) {
    const columns = fields.map((f) => COLUMNS[f]);
    const values = fields.map((f) => patch[f] ?? null);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO investor_profiles (user_id, ${columns.join(", ")}, updated_at)
         VALUES ($1, ${columns.map((_, i) => `$${i + 2}`).join(", ")}, now())
         ON CONFLICT (user_id) DO UPDATE SET ${columns.map((c) => `${c} = EXCLUDED.${c}`).join(", ")}, updated_at = now()`,
        [actor.userId, ...values]
      );
      await audit(client, actor, { action: "profile.update", entity: "investor_profile", entityId: actor.userId, detail: { fields } });
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
  return getProfile(actor.userId);
}
