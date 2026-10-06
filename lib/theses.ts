import { pool } from "./db";
import { FUNDAMENTAL_METRICS } from "./edgar";
import { DERIVED_METRICS } from "./metrics";
import { latestMetrics } from "./scoring";
import { addJournal } from "./ai/journal";
import { isUuid } from "./ids";

export type Operator = "<" | ">" | "<=" | ">=";

export interface Rule {
  metric: string;
  operator: Operator;
  value: number;
}

const OPERATORS: Operator[] = ["<", ">", "<=", ">="];

export const RULE_METRICS = [...Object.keys(DERIVED_METRICS), ...FUNDAMENTAL_METRICS].sort();

// The whole reason rules are stored as structure rather than as a sentence: the
// operator is matched against a fixed set and the comparison is arithmetic, so
// checking a thesis never involves interpreting text as code.
export function breaches(rule: Rule, actual: number): boolean {
  switch (rule.operator) {
    case "<":
      return actual < rule.value;
    case ">":
      return actual > rule.value;
    case "<=":
      return actual <= rule.value;
    case ">=":
      return actual >= rule.value;
  }
}

// Rules usually arrive from a model turning a sentence into structure, so every
// field is checked. A rule naming a metric that is never stored would sit there
// looking like a tripwire while never being able to fire, so that is refused
// too, rather than accepted and quietly ignored.
export function parseRules(input: unknown): Rule[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error("invalidation_rules must be a non-empty array");
  }

  return input.map((raw, index) => {
    const where = `rule ${index}`;
    if (typeof raw !== "object" || raw === null) {
      throw new Error(`${where} is not an object`);
    }

    const { metric, operator, value } = raw as Record<string, unknown>;

    if (typeof metric !== "string" || !RULE_METRICS.includes(metric)) {
      throw new Error(
        `${where} names unknown metric ${JSON.stringify(metric)}; nothing is stored under that name`
      );
    }
    if (typeof operator !== "string" || !OPERATORS.includes(operator as Operator)) {
      throw new Error(`${where} has operator ${JSON.stringify(operator)}, expected one of < > <= >=`);
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`${where} has a non-numeric value`);
    }

    return { metric, operator: operator as Operator, value };
  });
}

export interface RuleCheck {
  rule: Rule;
  actual: number | null;
  breached: boolean;
  note?: string;
}

export interface Thesis {
  id: string;
  companyId: string;
  ticker: string;
  name: string;
  openedAt: string;
  rationale: string | null;
  rules: Rule[];
  status: "open" | "invalidated" | "closed";
}

export interface ThesisEvaluation {
  thesis: Thesis;
  checks: RuleCheck[];
  breached: boolean;
  unresolved: number;
  periodEnd: string | null;
}

// A metric that cannot be resolved is reported as unresolved, never as a passing
// check: not knowing whether a thesis still holds is not the same as it holding.
export async function evaluateThesis(thesis: Thesis): Promise<ThesisEvaluation> {
  const { periodEnd, raw, derived } = await latestMetrics(thesis.companyId);

  const checks: RuleCheck[] = thesis.rules.map((rule) => {
    const value = derived.get(rule.metric) ?? raw.get(rule.metric);
    if (value === undefined) {
      return { rule, actual: null, breached: false, note: "no stored value for this metric" };
    }

    const actual = value.toNumber();
    return { rule, actual, breached: breaches(rule, actual) };
  });

  return {
    thesis,
    checks,
    breached: checks.some((c) => c.breached),
    unresolved: checks.filter((c) => c.actual === null).length,
    periodEnd,
  };
}

function toThesis(row: Record<string, unknown>): Thesis {
  return {
    id: row.id as string,
    companyId: row.company_id as string,
    ticker: row.ticker as string,
    name: row.name as string,
    openedAt: (row.opened_at as Date).toISOString(),
    rationale: (row.rationale as string) ?? null,
    rules: row.invalidation_rules as Rule[],
    status: row.status as Thesis["status"],
  };
}

export async function listTheses(status?: Thesis["status"]): Promise<ThesisEvaluation[]> {
  const { rows } = await pool.query(
    `SELECT t.id, t.company_id, c.ticker, c.name, t.opened_at, t.rationale,
            t.invalidation_rules, t.status
     FROM theses t
     JOIN companies c ON c.id = t.company_id
     WHERE ($1::text IS NULL OR t.status = $1)
     ORDER BY t.opened_at DESC`,
    [status ?? null]
  );

  return Promise.all(rows.map((row) => evaluateThesis(toThesis(row))));
}

export async function openThesis(
  companyId: string,
  rationale: string | null,
  rules: Rule[]
): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO theses (company_id, rationale, invalidation_rules)
     VALUES ($1, $2, $3) RETURNING id`,
    [companyId, rationale, JSON.stringify(rules)]
  );
  return rows[0].id;
}

// An open thesis on the same company with exactly these rules, so adopting the
// same committee twice does not leave two identical tripwires.
export async function findOpenThesis(companyId: string, rules: Rule[]): Promise<string | null> {
  const { rows } = await pool.query(
    `SELECT id FROM theses
     WHERE company_id = $1 AND status = 'open' AND invalidation_rules = $2::jsonb
     LIMIT 1`,
    [companyId, JSON.stringify(rules)]
  );
  return rows[0]?.id ?? null;
}

// Returns whether a thesis with that id existed.
export async function setThesisStatus(id: string, status: Thesis["status"]): Promise<boolean> {
  if (!isUuid(id)) return false;
  const { rowCount } = await pool.query(`UPDATE theses SET status = $2 WHERE id = $1`, [id, status]);
  return (rowCount ?? 0) > 0;
}

export interface CheckSummary {
  checked: number;
  invalidated: Array<{ thesisId: string; ticker: string; rule: Rule; actual: number }>;
  unresolved: Array<{ ticker: string; metric: string }>;
}

// Run after new filings land. Only open theses are touched, and only the status
// column changes — nothing here writes a number a person did not put there.
export async function checkOpenTheses(): Promise<CheckSummary> {
  const evaluations = await listTheses("open");
  const summary: CheckSummary = { checked: evaluations.length, invalidated: [], unresolved: [] };

  for (const evaluation of evaluations) {
    for (const check of evaluation.checks) {
      if (check.actual === null) {
        summary.unresolved.push({ ticker: evaluation.thesis.ticker, metric: check.rule.metric });
      } else if (check.breached) {
        summary.invalidated.push({
          thesisId: evaluation.thesis.id,
          ticker: evaluation.thesis.ticker,
          rule: check.rule,
          actual: check.actual,
        });
      }
    }

    if (evaluation.breached) {
      await setThesisStatus(evaluation.thesis.id, "invalidated");
      const crossed = evaluation.checks.filter((c) => c.breached);
      await addJournal({
        companyId: evaluation.thesis.companyId,
        kind: "thesis-invalidated",
        title: `Thesis on ${evaluation.thesis.ticker} no longer holds`,
        detail: crossed
          .map((c) => `${c.rule.metric} is ${Number((c.actual as number).toPrecision(4))} (rule: ${c.rule.operator} ${c.rule.value})`)
          .join("; "),
        refId: evaluation.thesis.id,
      });
    }
  }

  return summary;
}
