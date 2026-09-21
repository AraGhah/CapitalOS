import { cachedJson, cachedText } from "./sec";

interface Heading {
  item: string;
  title?: string;
}

// Item numbering follows the 10-K; the 10-Q equivalents sit alongside so the
// same section name works for both.
const SECTIONS: Record<string, { start: Heading[]; end: Heading[] }> = {
  business: {
    start: [{ item: "1", title: "Business" }],
    end: [{ item: "1A", title: "Risk Factors" }],
  },
  risk_factors: {
    start: [{ item: "1A", title: "Risk Factors" }],
    end: [
      { item: "1B", title: "Unresolved Staff Comments" },
      { item: "2", title: "Properties" },
    ],
  },
  mdna: {
    start: [
      { item: "7", title: "Management" },
      { item: "2", title: "Management" },
    ],
    end: [
      { item: "7A", title: "Quantitative" },
      { item: "3", title: "Quantitative" },
    ],
  },
  market_risk: {
    start: [
      { item: "7A", title: "Quantitative" },
      { item: "3", title: "Quantitative" },
    ],
    end: [
      { item: "8", title: "Financial Statements" },
      { item: "4", title: "Controls" },
    ],
  },
  financial_statements: {
    start: [{ item: "8", title: "Financial Statements" }],
    end: [{ item: "9", title: "Changes in and Disagreements" }],
  },
};

export const SECTION_NAMES = Object.keys(SECTIONS);

// Below this a match is a table of contents line or a page header, not a section.
const MIN_SECTION_CHARS = 1500;

// Letter spacing and styling markup break words apart once the tags come out
// ("ITEM 1A. RIS K FACTORS" in Microsoft's 10-K), so headings are matched with
// optional whitespace allowed between every character.
function spaced(phrase: string): string {
  return phrase
    .replace(/\s+/g, "")
    .split("")
    .map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`))
    .join(String.raw`\s*`);
}

function headingPattern({ item, title }: Heading): string {
  const numbered = spaced(`item${item}`) + String.raw`\s*[.:—-]?\s*`;
  return title ? numbered + spaced(title) : numbered;
}

interface DirectoryItem {
  name: string;
  type: string;
  size: string;
}

function accessionPath(cik: string, accession: string): string {
  return `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replace(/-/g, "")}`;
}

// The filing directory holds the report plus dozens of exhibits and rendered
// fragments, so prefer the document EDGAR labels with the form type and fall
// back to the largest page that isn't an index or an R-numbered fragment.
async function primaryDocument(cik: string, accession: string, formType: string): Promise<string> {
  const base = accessionPath(cik, accession);
  const index = (await cachedJson(`idx-${accession}`, `${base}/index.json`)) as {
    directory: { item: DirectoryItem[] };
  };

  const pages = index.directory.item.filter(
    (i) => /\.html?$/i.test(i.name) && !/index/i.test(i.name) && !/^R\d+\.htm/i.test(i.name)
  );
  if (pages.length === 0) throw new Error(`no readable document in filing ${accession}`);

  const labelled = pages.find((i) => i.type === formType);
  const chosen = labelled ?? pages.sort((a, b) => Number(b.size) - Number(a.size))[0];
  return `${base}/${chosen.name}`;
}

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|tr|h[1-6]|li|table)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&amp;/gi, "&")
    .replace(/[ \t ]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function matchOffsets(text: string, headings: Heading[], atLineStart: boolean): number[] {
  const offsets: number[] = [];
  for (const heading of headings) {
    const pattern = atLineStart
      ? String.raw`^[ \t]*(?:part\s*[ivx]+\s*[.:—-]?\s*)?` + headingPattern(heading)
      : headingPattern(heading);
    for (const match of text.matchAll(new RegExp(pattern, "gim"))) {
      if (match.index !== undefined) offsets.push(match.index);
    }
  }
  return offsets.sort((a, b) => a - b);
}

function longestSpan(
  text: string,
  starts: number[],
  ends: number[]
): { start: number; end: number } | null {
  let best: { start: number; end: number } | null = null;
  for (const start of starts) {
    const end = ends.find((e) => e > start) ?? text.length;
    if (!best || end - start > best.end - best.start) best = { start, end };
  }
  return best;
}

// Three things get in the way. Every item heading also appears in the table of
// contents, where the next heading follows within a few characters, so the
// longest span between a start and the next end skips those. Body prose
// cross-references other items mid-sentence ("see Item 1A. Risk Factors"), which
// would otherwise win that span outright, so headings that begin a line are
// tried first. And some filers index their items into a differently structured
// document, where no heading exists to find — a span too short to be a section
// means it wasn't located, and the caller is told to read the filing itself
// rather than handed a fragment of the contents page.
function sectionBounds(text: string, section: string): { start: number; end: number } | null {
  const { start: startHeadings, end: endHeadings } = SECTIONS[section];

  for (const atLineStart of [true, false]) {
    const best = longestSpan(
      text,
      matchOffsets(text, startHeadings, atLineStart),
      matchOffsets(text, endHeadings, atLineStart)
    );
    if (best && best.end - best.start >= MIN_SECTION_CHARS) return best;
  }
  return null;
}

export interface FilingSection {
  url: string;
  section: string;
  text: string;
  offset: number;
  returnedChars: number;
  totalChars: number;
}

export async function getFilingSection(
  cik: string,
  accession: string,
  formType: string,
  section: string,
  opts: { offset?: number; maxChars?: number } = {}
): Promise<FilingSection> {
  if (!(section in SECTIONS)) {
    throw new Error(`unknown section "${section}"; try one of: ${SECTION_NAMES.join(", ")}`);
  }

  const url = await primaryDocument(cik, accession, formType);
  const text = htmlToText(await cachedText(`doc-${accession}.htm`, url));

  const bounds = sectionBounds(text, section);
  if (!bounds) {
    throw new Error(`could not locate section "${section}" in ${accession}; read it at ${url}`);
  }

  const body = text.slice(bounds.start, bounds.end);
  const offset = Math.max(0, opts.offset ?? 0);
  const slice = body.slice(offset, offset + (opts.maxChars ?? 20000));

  return {
    url,
    section,
    text: slice,
    offset,
    returnedChars: slice.length,
    totalChars: body.length,
  };
}
