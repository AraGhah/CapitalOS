import { mkdir, readFile, writeFile } from "fs/promises";
import { join } from "path";

// SEC rejects requests that don't identify the caller with a contact address.
const USER_AGENT = process.env.SEC_USER_AGENT ?? "CapitalOS contact@example.com";
export const CACHE_DIR = join(process.cwd(), ".cache", "edgar");

let lastRequestAt = 0;

// SEC allows 10 requests/second; one every 120ms stays comfortably under it.
async function throttle() {
  const wait = 120 - (Date.now() - lastRequestAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();
}

async function fetchSec(url: string): Promise<Response> {
  await throttle();
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res;
}

async function cached(name: string, url: string, refresh: boolean): Promise<string> {
  await mkdir(CACHE_DIR, { recursive: true });
  const path = join(CACHE_DIR, name);

  if (!refresh) {
    try {
      return await readFile(path, "utf8");
    } catch {
      // not cached yet
    }
  }

  const body = await (await fetchSec(url)).text();
  await writeFile(path, body);
  return body;
}

export async function cachedJson(name: string, url: string, refresh = false): Promise<unknown> {
  return JSON.parse(await cached(`${name}.json`, url, refresh));
}

export async function cachedText(name: string, url: string, refresh = false): Promise<string> {
  return cached(name, url, refresh);
}
