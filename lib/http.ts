// Shared by every model client.

// An error page from a proxy or a provider outage is often HTML, and parsing it
// as JSON throws a SyntaxError that loses the status code. The body is read as
// text and parsed only if it is JSON.
export async function readJson<T>(res: Response): Promise<T | null> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

// 429 (rate limited), 503 and 529 (overloaded) are not billed and usually pass
// within seconds, so they are retried a couple of times; every other failure is
// returned to the caller as it is.
const RETRYABLE = new Set([429, 503, 529]);

export async function fetchWithRetry(url: string, init: RequestInit, attempts = 3): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, init);
    if (!RETRYABLE.has(res.status) || attempt >= attempts) return res;
    const after = Number(res.headers.get("retry-after"));
    const wait = Number.isFinite(after) && after > 0 ? Math.min(after * 1000, 30_000) : 2_000 * 2 ** (attempt - 1);
    await res.body?.cancel().catch(() => undefined);
    await new Promise((r) => setTimeout(r, wait));
  }
}
