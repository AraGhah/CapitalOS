import { afterEach, describe, expect, it } from "vitest";
import { pool } from "../../lib/db";
import { resetConfig } from "../../lib/config";
import { runRetention } from "../../lib/retention";
import { cachedSnapshot } from "../../lib/signals/store";

afterEach(() => {
  delete process.env.RETENTION_SIGNAL_DAYS;
  resetConfig();
});

describe("signal snapshots", () => {
  it("fetches once and reuses the reading while it is fresh", async () => {
    let fetched = 0;
    const fetcher = async () => {
      fetched++;
      return { bullish: 7 };
    };

    const first = await cachedSnapshot("stocktwits", "AAPL", 360, fetcher);
    const second = await cachedSnapshot("stocktwits", "AAPL", 360, fetcher);

    expect(fetched).toBe(1);
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.payload).toEqual({ bullish: 7 });
    expect(second.fetchedAt).toBe(first.fetchedAt);
  });

  it("keeps a reading per source and key", async () => {
    await cachedSnapshot("stocktwits", "AAPL", 360, async () => "a");
    const other = await cachedSnapshot("stocktwits", "MSFT", 360, async () => "m");
    const topic = await cachedSnapshot("polymarket", "aapl", 360, async () => "p");
    expect([other.cached, topic.cached]).toEqual([false, false]);
  });

  it("fetches again once the reading is older than the TTL", async () => {
    await cachedSnapshot("polymarket", "fed rate cut", 360, async () => "old");
    await pool.query(`UPDATE signal_snapshots SET fetched_at = now() - interval '7 hours'`);

    const fresh = await cachedSnapshot("polymarket", "fed rate cut", 360, async () => "new");
    expect(fresh).toMatchObject({ payload: "new", cached: false });

    // the old reading is history, not overwritten
    const { rows } = await pool.query(`SELECT payload FROM signal_snapshots ORDER BY fetched_at`);
    expect(rows.map((r) => r.payload)).toEqual(["old", "new"]);
  });

  it("serves the newest reading when several are still fresh", async () => {
    await pool.query(
      `INSERT INTO signal_snapshots (source, key, payload, fetched_at) VALUES
         ('stocktwits', 'NVDA', '"older"', now() - interval '2 hours'),
         ('stocktwits', 'NVDA', '"newer"', now() - interval '1 hour')`
    );
    const hit = await cachedSnapshot("stocktwits", "NVDA", 360, async () => "unused");
    expect(hit).toMatchObject({ payload: "newer", cached: true });
  });

  it("does not store a failed fetch, and lets the error through", async () => {
    await expect(
      cachedSnapshot("stocktwits", "AAPL", 360, async () => {
        throw new Error("403 Forbidden");
      })
    ).rejects.toThrow("403 Forbidden");
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM signal_snapshots`);
    expect(rows[0].n).toBe(0);
  });

  it("is trimmed by the retention job after RETENTION_SIGNAL_DAYS", async () => {
    process.env.RETENTION_SIGNAL_DAYS = "30";
    resetConfig();
    await pool.query(
      `INSERT INTO signal_snapshots (source, key, payload, fetched_at) VALUES
         ('stocktwits', 'OLD', '1', now() - interval '31 days'),
         ('stocktwits', 'NEW', '2', now() - interval '29 days')`
    );
    const result = await runRetention();
    expect(result.signalSnapshots).toBe(1);
    const { rows } = await pool.query(`SELECT key FROM signal_snapshots`);
    expect(rows.map((r) => r.key)).toEqual(["NEW"]);
  });
});
