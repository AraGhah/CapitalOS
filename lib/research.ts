import { pool } from "./db";
import { getSource, getSourceText, sourceBelongsTo, type SourceRow } from "./sources";

export const RESEARCH_FIELDS = ["outlook", "catalysts", "risks", "bull_case", "bear_case"] as const;
export type ResearchField = (typeof RESEARCH_FIELDS)[number];

export interface Claim {
  text: string;
  sourceId: string;
  snippet: string;
}

export interface StoredClaim extends Claim {
  id: string;
  createdAt: string;
  source: SourceRow;
}

// Short enough to match by accident; a snippet this small proves nothing.
const MIN_SNIPPET_CHARS = 25;

// Filings render quotes and dashes as typographic characters and break lines
// wherever the layout demands, none of which changes what was written. Case is
// ignored too, since headings arrive shouted. Everything else must match, so the
// words and their order still have to come from the source.
function normalizeForMatch(text: string): string {
  return text
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export interface RejectedClaim {
  index: number;
  reason: string;
}

export interface AddResult {
  inserted: number;
  duplicates: number;
  rejected: RejectedClaim[];
}

// The database already refuses a claim with no source or snippet through its NOT
// NULL columns. This is the check in front of that one: it also refuses a snippet
// that cannot be found in the source it cites, which is the failure the columns
// cannot see.
export async function addClaims(
  userId: string,
  companyId: string,
  field: ResearchField,
  claims: Claim[]
): Promise<AddResult> {
  const rejected: RejectedClaim[] = [];
  const accepted: Claim[] = [];
  const sourceTexts = new Map<string, string>();

  for (const [index, claim] of claims.entries()) {
    const text = claim.text?.trim() ?? "";
    const snippet = claim.snippet?.trim() ?? "";
    const sourceId = claim.sourceId?.trim() ?? "";

    if (!text) {
      rejected.push({ index, reason: "claim text is empty" });
      continue;
    }
    if (!sourceId) {
      rejected.push({ index, reason: "claim has no sourceId" });
      continue;
    }
    if (snippet.length < MIN_SNIPPET_CHARS) {
      rejected.push({
        index,
        reason: `snippet must be at least ${MIN_SNIPPET_CHARS} characters of the source`,
      });
      continue;
    }

    let sourceText = sourceTexts.get(sourceId);
    if (sourceText === undefined) {
      const source = await getSource(sourceId);
      if (!source) {
        rejected.push({ index, reason: `no source stored with id ${sourceId}` });
        continue;
      }
      if (!(await sourceBelongsTo(source, companyId))) {
        rejected.push({ index, reason: `source ${sourceId} is not a filing or headline of this company` });
        continue;
      }
      try {
        sourceText = normalizeForMatch(await getSourceText(source));
      } catch (err) {
        rejected.push({ index, reason: (err as Error).message });
        continue;
      }
      sourceTexts.set(sourceId, sourceText);
    }

    if (!sourceText.includes(normalizeForMatch(snippet))) {
      rejected.push({ index, reason: "snippet does not appear in the source it cites" });
      continue;
    }

    accepted.push({ text, sourceId, snippet });
  }

  let inserted = 0;
  let duplicates = 0;

  for (const claim of accepted) {
    const { rowCount } = await pool.query(
      `INSERT INTO research_notes (user_id, company_id, field, claim, source_id, snippet)
       SELECT $6, $1, $2, $3, $4, $5
       WHERE NOT EXISTS (
         SELECT 1 FROM research_notes
         WHERE user_id = $6 AND company_id = $1 AND field = $2 AND claim = $3 AND source_id = $4
       )`,
      [companyId, field, claim.text.slice(0, 2000), claim.sourceId, claim.snippet.slice(0, 4000), userId]
    );
    if (rowCount === 0) duplicates++;
    else inserted++;
  }

  return { inserted, duplicates, rejected };
}

export interface ResearchCoverage {
  inputs: Array<{ name: string; present: boolean }>;
  present: number;
  expected: number;
  fieldsWritten: number;
  scoreComponents: number;
  scoreSpread: number | null;
}

// Coverage counts what was actually retrieved and how far the score components
// disagree. Both are read off stored rows, which is the point: a model cannot
// talk its way into a better number the way a self-reported confidence invites.
export async function getCoverage(userId: string, companyId: string): Promise<ResearchCoverage> {
  const { rows } = await pool.query(
    `SELECT
       (SELECT sector IS NOT NULL FROM companies WHERE id = $1) AS profile,
       EXISTS (SELECT 1 FROM fundamentals WHERE company_id = $1 AND fiscal_period = 'FY') AS fundamentals,
       EXISTS (SELECT 1 FROM scores WHERE company_id = $1) AS score,
       EXISTS (SELECT 1 FROM prices_daily WHERE company_id = $1) AS prices,
       EXISTS (SELECT 1 FROM filings WHERE company_id = $1) AS filings,
       (SELECT count(DISTINCT field) FROM research_notes WHERE company_id = $1 AND user_id = $2) AS fields_written,
       (SELECT count(*) FROM scores WHERE company_id = $1
          AND as_of = (SELECT max(as_of) FROM scores WHERE company_id = $1)) AS score_components,
       (SELECT max(percentile) - min(percentile) FROM scores WHERE company_id = $1
          AND as_of = (SELECT max(as_of) FROM scores WHERE company_id = $1)) AS score_spread`,
    [companyId, userId]
  );

  const row = rows[0];
  const inputs = [
    { name: "sector classified", present: row.profile === true },
    { name: "annual fundamentals", present: row.fundamentals },
    { name: "score computed", present: row.score },
    { name: "price history", present: row.prices },
    { name: "filings indexed", present: row.filings },
  ];

  return {
    inputs,
    present: inputs.filter((i) => i.present).length,
    expected: inputs.length,
    fieldsWritten: Number(row.fields_written),
    scoreComponents: Number(row.score_components),
    scoreSpread: row.score_spread === null ? null : Number(row.score_spread),
  };
}

export interface ResearchNote {
  companyId: string;
  ticker: string;
  name: string;
  fields: Record<ResearchField, StoredClaim[]>;
  coverage: ResearchCoverage;
}

function emptyFields(): Record<ResearchField, StoredClaim[]> {
  const fields = {} as Record<ResearchField, StoredClaim[]>;
  for (const field of RESEARCH_FIELDS) fields[field] = [];
  return fields;
}

export async function getResearchNote(
  userId: string,
  companyId: string,
  ticker: string,
  name: string
): Promise<ResearchNote> {
  const { rows } = await pool.query(
    `SELECT rn.id, rn.field, rn.claim, rn.snippet, rn.created_at,
            s.id AS source_id, s.kind, s.url, s.title, s.published_at, s.retrieved_at, s.raw_hash
     FROM research_notes rn
     JOIN sources s ON s.id = rn.source_id
     WHERE rn.company_id = $1 AND rn.user_id = $2
     ORDER BY rn.field, rn.created_at`,
    [companyId, userId]
  );

  const fields = emptyFields();
  for (const row of rows) {
    if (!RESEARCH_FIELDS.includes(row.field)) continue;
    fields[row.field as ResearchField].push({
      id: row.id,
      text: row.claim,
      snippet: row.snippet,
      sourceId: row.source_id,
      createdAt: (row.created_at as Date).toISOString(),
      source: {
        id: row.source_id,
        kind: row.kind,
        url: row.url,
        title: row.title,
        publishedAt: row.published_at
          ? (row.published_at as Date).toISOString().slice(0, 10)
          : null,
        retrievedAt: (row.retrieved_at as Date).toISOString(),
        rawHash: row.raw_hash,
      },
    });
  }

  return { companyId, ticker, name, fields, coverage: await getCoverage(userId, companyId) };
}
