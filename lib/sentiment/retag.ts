import { pool } from "../db";
import { saveTags } from "../dossier";
import { LEXICON_PROVIDER, tagByLexicon, type Sentiment } from "../sentiment";

/* ---------------------------------------------------------------------------
   Labelling the headlines already stored with the current rules.

   Headlines tagged before the rule-based tagger was rebuilt carry the provider
   "lexicon" (the old forty-word list). This relabels them with the current
   rules and records the new provider, so the study can tell the two apart.
   Headlines a model labelled are never touched: the model was asked, and paid
   for, and the rules have no business overruling it.

   Dry-run by default. Applying changes labels, and a company's dossier is
   cached on its headlines' labels, so the next pipeline run for a company
   whose labels moved is a cache miss — one model run if a key is configured,
   free otherwise.
--------------------------------------------------------------------------- */

const SENTIMENTS: readonly Sentiment[] = ["bullish", "neutral", "bearish"];
const BATCH = 1000;

export interface RetagReport {
  // the provider whose labels were reconsidered
  replaced: string;
  considered: number;
  changed: number;
  // companies with at least one changed label
  companies: number;
  // matrix[before][after]
  matrix: Record<Sentiment, Record<Sentiment, number>>;
  applied: boolean;
}

// Only the rule-based providers can be relabelled; a model's labels are left alone.
export function isRetaggable(provider: string): boolean {
  return provider === "lexicon" || provider.startsWith("lexicon:");
}

export async function retag(options: { apply: boolean; provider?: string }): Promise<RetagReport> {
  const replaced = options.provider ?? "lexicon";
  if (!isRetaggable(replaced)) throw new Error(`${replaced} is not a rule-based provider; only labels from the word list or the rules can be relabelled`);

  const { rows } = await pool.query(
    `SELECT id, company_id, title, sentiment FROM headlines WHERE sentiment_provider = $1 AND sentiment IS NOT NULL ORDER BY id`,
    [replaced]
  );

  const matrix = Object.fromEntries(SENTIMENTS.map((from) => [from, { bullish: 0, neutral: 0, bearish: 0 }])) as RetagReport["matrix"];
  const moved = new Set<string>();
  const next: Array<{ id: string; sentiment: Sentiment }> = [];
  let changed = 0;
  for (const row of rows) {
    const before = row.sentiment as Sentiment;
    const after = tagByLexicon(row.title as string);
    matrix[before][after] += 1;
    if (before !== after) {
      changed += 1;
      moved.add(row.company_id as string);
    }
    next.push({ id: row.id as string, sentiment: after });
  }

  // Every considered headline is rewritten, changed or not: its provider is what
  // moves it from the word list's record to the rules'.
  if (options.apply && replaced !== LEXICON_PROVIDER) {
    for (let i = 0; i < next.length; i += BATCH) await saveTags(next.slice(i, i + BATCH), LEXICON_PROVIDER);
  }

  return { replaced, considered: rows.length, changed, companies: moved.size, matrix, applied: options.apply && replaced !== LEXICON_PROVIDER };
}
