import { z } from "zod";
import { ACCOUNT_TYPES, OBJECTIVES, RISK_TOLERANCES } from "../profile-fields";

/* ---------------------------------------------------------------------------
   Request schemas shared by the API routes, the OpenAPI document and the
   tests. A route never reads a field that is not declared here.
--------------------------------------------------------------------------- */

export const Ticker = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z][A-Z0-9.\-]{0,9}$/, "not a ticker symbol");

export const Uuid = z.uuid();

// A number, or a string that is one — never NaN, Infinity or "1e999".
export const DecimalString = z
  .union([z.number().finite(), z.string().trim().regex(/^-?\d+(\.\d+)?$/, "must be a plain decimal number")])
  .transform((v) => String(v));

export const TransactionCreate = z.object({
  ticker: Ticker,
  side: z.enum(["buy", "sell"]),
  qty: DecimalString,
  price: DecimalString,
  fees: DecimalString.optional(),
  executedAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/, "a date like 2026-10-05"),
  note: z.string().trim().max(500).optional(),
  idempotencyKey: z.string().trim().min(8).max(128).optional(),
});

export const TransactionVoid = z.object({ reason: z.string().trim().min(1).max(500) });

export const WatchlistAdd = z.object({
  ticker: Ticker,
  note: z.string().trim().max(500).optional(),
});

export const AlertStatus = z.object({
  id: Uuid,
  status: z.enum(["new", "seen", "dismissed"]),
});

export const AutopilotRun = z.object({ convene: z.boolean().optional() });

export const ChatQuestion = z.object({
  question: z.string().trim().min(1, "ask something").max(4000, "keep the question under 4000 characters"),
  // replace the latest answer with a new one to the same question
  regenerate: z.boolean().optional(),
});

export const ConsensusStart = z.object({
  ticker: Ticker,
  mode: z.enum(["auto", "fast", "standard", "deep", "committee"]).default("standard"),
  focus: z.string().trim().max(400).optional(),
  modelIds: z.array(z.string().max(64)).max(20).optional(),
  force: z.boolean().optional(),
});

export const JournalNote = z.object({
  ticker: Ticker.optional(),
  title: z.string().trim().min(1, "a note needs a title").max(200),
  detail: z.string().trim().max(2000).optional(),
});

export const PaperOrder = z
  .object({
    ticker: Ticker,
    side: z.enum(["buy", "sell"]),
    dollars: z.number().positive().max(1e9).optional(),
    qty: z.number().positive().max(1e9).optional(),
    runId: Uuid.optional(),
    rationale: z.string().trim().max(500).optional(),
  })
  .refine((o) => o.dollars !== undefined || o.qty !== undefined, "an order needs a quantity or a dollar amount");

const Op = z.enum([">=", "<=", ">", "<"]);

export const BacktestSpec = z.object({
  name: z.string().trim().max(120).default("Custom strategy"),
  rules: z.array(z.object({ metric: z.string(), op: Op, value: z.number().finite() })).max(12).default([]),
  rankBy: z.string(),
  rankDescending: z.boolean().default(true),
  maxPositions: z.number().int().min(1).max(10),
  rebalance: z.enum(["monthly", "quarterly", "annual"]),
  costBps: z.number().min(0).max(200),
  slippageBps: z.number().min(0).max(200),
  years: z.number().int().min(1).max(10),
  universe: z.array(Ticker).max(100).optional(),
});

export const QuoteRange = z.enum(["5d", "1mo", "3mo", "6mo", "1y", "2y", "5y"]).catch("1mo");

export const Currency = z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, "a three-letter currency code like USD or CAD");

export const CashCreate = z.object({
  kind: z.enum(["deposit", "withdrawal", "dividend", "interest", "fee", "tax"]),
  amount: DecimalString,
  currency: Currency,
  occurredAt: z.string().regex(/^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/, "a date like 2026-10-05"),
  ticker: Ticker.optional(),
  note: z.string().trim().max(500).optional(),
  idempotencyKey: z.string().trim().min(8).max(128).optional(),
});

export const AccountPatch = z
  .object({
    baseCurrency: Currency.optional(),
    tracksCash: z.boolean().optional(),
    name: z.string().trim().min(1).max(80).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "nothing to change");

const Money = z.number().finite().min(0).max(1e12).nullable();
const Share = z.number().finite().min(0).max(1).nullable();

// The investor profile: every field optional (a patch), and null clears one.
export const ProfilePatch = z
  .object({
    monthlyExpenses: Money,
    emergencyFund: Money,
    highInterestDebt: Money,
    investableAmount: Money,
    positionSize: Money,
    objective: z.enum(OBJECTIVES).nullable(),
    horizonYears: z.number().finite().min(0).max(100).nullable(),
    maxLossShare: Share,
    riskTolerance: z.enum(RISK_TOLERANCES).nullable(),
    accountType: z.enum(ACCOUNT_TYPES).nullable(),
    contributionRoom: Money,
    tradingCostShare: Share,
    institution: z.string().trim().max(120).nullable(),
    institutionVerified: z.boolean().nullable(),
  })
  .partial()
  .strict();

export const PositionSize = z.coerce.number().finite().min(0).max(1e12);
