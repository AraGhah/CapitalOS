import { readJson } from "../http";

// Shared by the outside-signal feeds. Each one is public, keyless and allowed
// to be down, so a fetch is short and its failure is an ordinary error the
// caller reports as "not retrieved".

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const UA = "CapitalOS/1.0 (personal research desk)";
export const SIGNAL_TIMEOUT_MS = 8_000;

const defaultFetch: FetchLike = (url, init) => fetch(url, init);

export async function getJson(url: string, fetchImpl: FetchLike = defaultFetch, timeoutMs = SIGNAL_TIMEOUT_MS): Promise<unknown> {
  const res = await fetchImpl(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`.trim());
  const body = await readJson<unknown>(res);
  if (body === null) throw new Error("the response was not JSON");
  return body;
}

// Text written by strangers ends up in the evidence pack a model reads, so it
// is flattened to one printable line and cut: no newline can start a fake
// section, and one long title cannot crowd the pack. \p{Cc} is every control
// character, \p{Zl} and \p{Zp} the Unicode line and paragraph separators.
export function cleanText(text: string, max = 160): string {
  const flat = text.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

export function isoDay(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  const t = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}
