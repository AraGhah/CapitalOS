import { mkdir, readFile, stat, writeFile } from "fs/promises";
import { join } from "path";

// SEC rejects requests that don't identify the caller with a contact address.
const USER_AGENT = process.env.SEC_USER_AGENT ?? "CapitalOS contact@example.com";
export const CACHE_DIR = join(process.cwd(), ".cache", "edgar");
const TIMEOUT_MS = 30_000;

// How long a cached response stands in for a fresh one. Company facts and
// submissions change every time something is filed, and the ticker list every
// time something lists, so they expire; a filing's own documents never change
// after it is filed, so they are kept for good.
export const DAY_MS = 24 * 60 * 60 * 1000;
export const FOREVER = Number.POSITIVE_INFINITY;

// SEC allows 10 requests/second; one every 120ms stays comfortably under it.
// Requests take turns on a chain rather than each reading a shared timestamp,
// which concurrent callers would all read before any of them updated it.
const GAP_MS = 120;
let queue: Promise<void> = Promise.resolve();

function throttle(): Promise<void> {
  const turn = queue.then(() => new Promise<void>((r) => setTimeout(r, GAP_MS)));
  queue = turn.catch(() => undefined);
  return queue;
}

async function fetchSec(url: string): Promise<Response> {
  await throttle();
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res;
}

// Cache names are built from SEC identifiers; anything else in one is refused
// so a name can never point outside the cache directory.
function cachePath(name: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name.includes("..")) {
    throw new Error(`invalid cache name "${name}"`);
  }
  return join(CACHE_DIR, name);
}

async function cached(name: string, url: string, refresh: boolean, maxAgeMs: number): Promise<string> {
  await mkdir(CACHE_DIR, { recursive: true });
  const path = cachePath(name);

  if (!refresh) {
    try {
      const age = Date.now() - (await stat(path)).mtimeMs;
      if (age <= maxAgeMs) return await readFile(path, "utf8");
    } catch {
      // not cached yet
    }
  }

  try {
    const body = await (await fetchSec(url)).text();
    await writeFile(path, body);
    return body;
  } catch (err) {
    // SEC unreachable: an expired copy is still better than nothing.
    try {
      return await readFile(path, "utf8");
    } catch {
      throw err;
    }
  }
}

export async function cachedJson(name: string, url: string, refresh = false, maxAgeMs = DAY_MS): Promise<unknown> {
  return JSON.parse(await cached(`${name}.json`, url, refresh, maxAgeMs));
}

export async function cachedText(name: string, url: string, refresh = false, maxAgeMs = DAY_MS): Promise<string> {
  return cached(name, url, refresh, maxAgeMs);
}
