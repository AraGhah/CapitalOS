import { describe, expect, it } from "vitest";
import { pool } from "../../lib/db";
import { storeHeadlines } from "../../lib/dossier";
import { company } from "./db";

const article = (n: number) => ({
  url: `https://news.example.com/story-${n}`,
  title: `Story ${n} about ACME`,
  domain: "news.example.com",
  publishedAt: "2026-10-01T12:00:00.000Z",
});

describe("headline storage (PERF-01, DB-02)", () => {
  it("stores each story once even when scouts race", async () => {
    const acme = await company("ACME");
    const batch = Array.from({ length: 50 }, (_, i) => article(i));
    const results = await Promise.all([
      storeHeadlines(acme, "gdelt", batch),
      storeHeadlines(acme, "google_news", batch),
      storeHeadlines(acme, "gdelt", [...batch, article(0)]),
    ]);
    expect(results.reduce((s, n) => s + n, 0)).toBe(50);
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM sources WHERE kind = 'news'`);
    expect(rows[0].n).toBe(50);
  });

  it("shares one source between companies a story is about", async () => {
    const a = await company("AAA");
    const b = await company("BBB");
    expect(await storeHeadlines(a, "gdelt", [article(1)])).toBe(1);
    expect(await storeHeadlines(b, "gdelt", [article(1)])).toBe(1);
    const { rows } = await pool.query(`SELECT count(DISTINCT source_id)::int AS n FROM headlines`);
    expect(rows[0].n).toBe(1);
  });

  it("refuses a lower-case ticker", async () => {
    await expect(pool.query(`INSERT INTO companies (ticker, name) VALUES ('acme', 'x')`)).rejects.toThrow(/companies_ticker_upper/);
  });
});
