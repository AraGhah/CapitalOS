import { createHash } from "crypto";
import { pool } from "./db";
import { getFilingText } from "./filing-text";

export interface SourceRow {
  id: string;
  kind: string;
  url: string;
  title: string | null;
  publishedAt: string | null;
  retrievedAt: string;
  rawHash: string | null;
}

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// The document URL carries the accession in its path, which is how a stored
// source finds its way back to the filing it was taken from. sources has no
// column for it, and inventing one would mean changing the schema from Step 0.
function accessionFromUrl(url: string): string | null {
  const match = url.match(/\/data\/\d+\/(\d{18})\//);
  if (!match) return null;
  const digits = match[1];
  return `${digits.slice(0, 10)}-${digits.slice(10, 12)}-${digits.slice(12)}`;
}

async function filingByAccession(accession: string) {
  const { rows } = await pool.query(
    `SELECT f.accession, f.form_type, f.filed_at, c.cik, c.ticker
     FROM filings f
     JOIN companies c ON c.id = f.company_id
     WHERE f.accession = $1`,
    [accession]
  );
  return rows[0] ?? null;
}

// Recording the same document twice would let two claims cite what is really one
// source, so an existing row for the identical URL and content is reused.
export async function registerFilingSource(
  accession: string
): Promise<{ sourceId: string; url: string; text: string }> {
  const filing = await filingByAccession(accession);
  if (!filing) throw new Error(`no filing stored with accession ${accession}`);
  if (!filing.cik) throw new Error(`no CIK stored for ${filing.ticker}`);

  const { url, text } = await getFilingText(filing.cik, accession, filing.form_type);
  const rawHash = hash(text);

  const existing = await pool.query(`SELECT id FROM sources WHERE url = $1 AND raw_hash = $2`, [
    url,
    rawHash,
  ]);
  if (existing.rows.length > 0) {
    return { sourceId: existing.rows[0].id, url, text };
  }

  const filedAt = (filing.filed_at as Date).toISOString().slice(0, 10);
  const { rows } = await pool.query(
    `INSERT INTO sources (kind, url, title, published_at, raw_hash)
     VALUES ('filing', $1, $2, $3, $4)
     RETURNING id`,
    [url, `${filing.ticker} ${filing.form_type} filed ${filedAt}`, filedAt, rawHash]
  );

  return { sourceId: rows[0].id, url, text };
}

export async function getSource(sourceId: string): Promise<SourceRow | null> {
  const { rows } = await pool.query(
    `SELECT id, kind, url, title, published_at, retrieved_at, raw_hash FROM sources WHERE id = $1`,
    [sourceId]
  );
  if (rows.length === 0) return null;

  const row = rows[0];
  return {
    id: row.id,
    kind: row.kind,
    url: row.url,
    title: row.title,
    publishedAt: row.published_at ? (row.published_at as Date).toISOString().slice(0, 10) : null,
    retrievedAt: (row.retrieved_at as Date).toISOString(),
    rawHash: row.raw_hash,
  };
}

// Returns the text a snippet must be found in. A source whose text cannot be
// recovered is reported as such rather than quietly passing every snippet put
// against it.
export async function getSourceText(source: SourceRow): Promise<string> {
  // News discovery stores the headline and nothing else, so the headline is the
  // whole of what a claim citing one is allowed to quote. Anything deeper would
  // need the article body fetched and stored first.
  if (source.kind === "news") {
    if (!source.title) throw new Error(`news source ${source.id} has no stored headline`);
    return source.title;
  }

  if (source.kind !== "filing") {
    throw new Error(`cannot verify snippets against a "${source.kind}" source yet`);
  }

  const accession = accessionFromUrl(source.url);
  if (!accession) throw new Error(`cannot work out the filing behind ${source.url}`);

  const filing = await filingByAccession(accession);
  if (!filing?.cik) throw new Error(`no stored filing for ${accession}`);

  const { text } = await getFilingText(filing.cik, accession, filing.form_type);
  if (source.rawHash && hash(text) !== source.rawHash) {
    throw new Error(`document at ${source.url} has changed since it was recorded`);
  }
  return text;
}
