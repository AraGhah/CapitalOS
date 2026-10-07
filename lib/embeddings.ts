import { config } from "./config";

// Headlines are short and repetitive, and near-duplicate detection mostly comes
// down to which words two of them share. A hosted embedding model does that
// better, so it is used when a key is present, but the local vectors below keep
// clustering working without an account or a per-run bill.

const LOCAL_DIMENSIONS = 512;

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "if", "as", "at", "by", "for", "from", "in", "into",
  "of", "on", "to", "with", "is", "are", "was", "were", "be", "been", "being", "it", "its",
  "this", "that", "these", "those", "he", "she", "they", "them", "his", "her", "their",
  "will", "would", "can", "could", "may", "might", "should", "has", "have", "had", "do",
  "does", "did", "not", "no", "so", "than", "then", "there", "here", "up", "down", "out",
  "over", "under", "after", "before", "about", "amid", "says", "said", "new", "more",
]);

// Coverage of one story says the same thing several ways: "beats" against
// "beat", "third quarter" against "Q3". Folding those together before hashing is
// what lets the local vectors recognise a paraphrase rather than only a reprint.
const QUARTERS: Array<[RegExp, string]> = [
  [/\bfirst[- ]quarter\b|\bq1\b/g, "q1"],
  [/\bsecond[- ]quarter\b|\bq2\b/g, "q2"],
  [/\bthird[- ]quarter\b|\bq3\b/g, "q3"],
  [/\bfourth[- ]quarter\b|\bq4\b/g, "q4"],
];

// Plurals only. Stripping "-ed" and "-ing" as well would split pairs like
// "announce" and "announced" onto different stems more often than it joined them.
function stem(token: string): string {
  if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

function tokenize(text: string): string[] {
  let normalized = text.toLowerCase();
  for (const [pattern, replacement] of QUARTERS) normalized = normalized.replace(pattern, replacement);

  return normalized
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .map(stem)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

// FNV-1a, for spreading tokens across the vector without a dependency.
function hashToken(token: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % LOCAL_DIMENSIONS;
}

function localVector(text: string): number[] {
  const vector = new Array<number>(LOCAL_DIMENSIONS).fill(0);
  for (const token of tokenize(text)) {
    vector[hashToken(token)] += 1;
  }

  const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  if (magnitude === 0) return vector;
  return vector.map((v) => v / magnitude);
}

async function openAiVectors(texts: string[], apiKey: string): Promise<number[][]> {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: "text-embedding-3-small", input: texts }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    throw new Error(`embeddings request failed: ${res.status} ${await res.text()}`);
  }

  const body = (await res.json()) as { data: Array<{ index: number; embedding: number[] }> };
  const vectors = new Array<number[]>(texts.length);
  for (const item of body.data) vectors[item.index] = item.embedding;
  return vectors;
}

export interface Embeddings {
  provider: string;
  vectors: number[][];
}

export async function embed(texts: string[]): Promise<Embeddings> {
  if (texts.length === 0) return { provider: "none", vectors: [] };

  const apiKey = config().OPENAI_API_KEY;
  if (apiKey) {
    return { provider: "openai:text-embedding-3-small", vectors: await openAiVectors(texts, apiKey) };
  }
  return { provider: "local:hashed-tokens", vectors: texts.map(localVector) };
}

export function cosineSim(a: number[], b: number[]): number {
  const dot = a.reduce((s, v, i) => s + v * b[i], 0);
  const magA = Math.sqrt(a.reduce((s, v) => s + v * v, 0));
  const magB = Math.sqrt(b.reduce((s, v) => s + v * v, 0));
  if (magA === 0 || magB === 0) return 0;
  return dot / (magA * magB);
}
