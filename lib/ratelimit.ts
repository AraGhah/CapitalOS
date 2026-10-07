import { pool } from "./db";
import { HttpError } from "./http/errors";

/* ---------------------------------------------------------------------------
   Rate limits shared by every process, as token buckets in Postgres.

   A bucket holds up to `capacity` tokens and refills at `perSecond`. Taking a
   token is one atomic upsert: the refill since the last take is added, capped
   at capacity, and one token is taken only if one is there. Two processes
   racing for the last token cannot both get it.

   Upstream limits (SEC, GDELT, model providers) wait for a token; a person's
   API write limit refuses with 429 instead of waiting.
--------------------------------------------------------------------------- */

export interface Bucket {
  key: string;
  capacity: number;
  perSecond: number;
}

// Takes one token if available. Returns 0 on success, otherwise the seconds
// until one will be.
export async function tryTake(b: Bucket): Promise<number> {
  const { rows } = await pool.query(
    `INSERT INTO rate_limits (key, tokens, updated_at) VALUES ($1, $2 - 1, clock_timestamp())
     ON CONFLICT (key) DO UPDATE SET
       tokens = LEAST($2, rate_limits.tokens + EXTRACT(EPOCH FROM clock_timestamp() - rate_limits.updated_at) * $3) - 1,
       updated_at = clock_timestamp()
     WHERE LEAST($2, rate_limits.tokens + EXTRACT(EPOCH FROM clock_timestamp() - rate_limits.updated_at) * $3) >= 1
     RETURNING tokens`,
    [b.key, b.capacity, b.perSecond]
  );
  if (rows[0]) return 0;

  const { rows: now } = await pool.query(
    `SELECT LEAST($2, tokens + EXTRACT(EPOCH FROM clock_timestamp() - updated_at) * $3) AS tokens
     FROM rate_limits WHERE key = $1`,
    [b.key, b.capacity, b.perSecond]
  );
  const tokens = Number(now[0]?.tokens ?? 0);
  return Math.max(0.05, (1 - tokens) / b.perSecond);
}

// Waits for a token, up to maxWaitMs.
export async function take(b: Bucket, maxWaitMs = 120_000): Promise<void> {
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    const wait = await tryTake(b);
    if (wait === 0) return;
    if (Date.now() + wait * 1000 > deadline) {
      throw new Error(`rate limit "${b.key}" would not free up within ${Math.round(maxWaitMs / 1000)}s`);
    }
    await new Promise((r) => setTimeout(r, Math.min(wait * 1000, 5_000)));
  }
}

// For the API: a person may start this many costly operations per minute.
export async function limitUser(userId: string, action: string, perMinute: number): Promise<void> {
  const wait = await tryTake({ key: `user:${userId}:${action}`, capacity: perMinute, perSecond: perMinute / 60 });
  if (wait > 0) {
    throw new HttpError(429, `slow down: try again in ${Math.ceil(wait)} seconds`, "rate_limited");
  }
}

/* ---------------------------------------------------------- local limits */

// At most `n` of something at once in this process (concurrent model calls),
// on top of the shared per-minute bucket.
export class Semaphore {
  private active = 0;
  private waiting: Array<() => void> = [];

  constructor(private readonly n: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.n) await new Promise<void>((r) => this.waiting.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

/* -------------------------------------------------------- known upstreams */

export const UPSTREAM = {
  // SEC asks for no more than 10 requests a second across a whole client.
  sec: { key: "upstream:sec", capacity: 8, perSecond: 8 },
  // GDELT throttles anything faster than one request every five seconds.
  gdelt: { key: "upstream:gdelt", capacity: 1, perSecond: 1 / 6 },
  yahoo: { key: "upstream:yahoo", capacity: 10, perSecond: 2 },
  alpaca: { key: "upstream:alpaca", capacity: 20, perSecond: 3 },
  // Per provider, per minute; overridable per provider in models.json.
  provider: (name: string, perMinute: number): Bucket => ({
    key: `upstream:llm:${name}`,
    capacity: Math.max(1, Math.round(perMinute / 6)),
    perSecond: perMinute / 60,
  }),
} satisfies Record<string, Bucket | ((...args: never[]) => Bucket)>;
