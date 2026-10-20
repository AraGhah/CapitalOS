import { afterEach, describe, expect, it, vi } from "vitest";
import { buildEvidence } from "../../lib/ai/evidence";
import { findCompany } from "../../lib/company";
import { resetConfig } from "../../lib/config";
import { pool } from "../../lib/db";
import { company } from "./db";

const OWNER = { userId: "00000000-0000-0000-0000-000000000001", accountId: "00000000-0000-0000-0000-000000000001" };

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.SIGNAL_FEEDS;
  resetConfig();
});

// A year of daily bars ending today, so the desk's own prices are fresh enough
// that the market-data provider is never asked.
async function seedPrices(companyId: string) {
  const day = 86_400_000;
  const rows: unknown[][] = [];
  for (let i = 259; i >= 0; i--) {
    const close = 100 + (259 - i) * 0.3 + Math.sin(i / 6) * 2;
    const date = new Date(Date.now() - i * day).toISOString().slice(0, 10);
    rows.push([companyId, date, close - 0.2, close + 1, close - 1, close, 1_000_000 + i * 1000]);
  }
  for (const row of rows) {
    await pool.query(
      `INSERT INTO prices_daily (company_id, date, open, high, low, close, volume) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      row
    );
  }
}

const bullishPost = { created_at: new Date().toISOString(), entities: { sentiment: { basic: "Bullish" } } };
const bearishPost = { created_at: new Date().toISOString(), entities: { sentiment: { basic: "Bearish" } } };

function stubNetwork() {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    calls.push(String(url));
    if (String(url).includes("stocktwits.com")) {
      return new Response(JSON.stringify({ messages: [...Array(7).fill(bullishPost), ...Array(3).fill(bearishPost)] }), { status: 200 });
    }
    return new Response(
      JSON.stringify({
        events: [
          {
            slug: "fed-december",
            markets: [
              {
                question: "Will the Fed cut rates in December?",
                closed: false,
                endDate: "2099-12-31T00:00:00Z",
                outcomes: '["Yes","No"]',
                outcomePrices: '["0.62","0.38"]',
                volumeNum: 5_000_000,
              },
            ],
          },
        ],
      }),
      { status: 200 }
    );
  });
  return calls;
}

describe("the evidence pack with technicals and outside signals", () => {
  it("carries the technical indicators computed from the stored bars", async () => {
    process.env.SIGNAL_FEEDS = "none";
    resetConfig();
    const calls = stubNetwork();
    await seedPrices(await company("AAPL"));

    const pack = await buildEvidence((await findCompany("AAPL"))!, OWNER);

    const technical = pack.items.filter((i) => i.kind === "technical");
    expect(technical.length).toBeGreaterThan(15);
    expect(technical.find((i) => /RSI\(14\)/.test(i.label))?.value).toBeGreaterThan(0);
    expect(pack.coverage.inputs).toContainEqual({ name: "technical indicators", present: true });
    // ids are assigned in order and are unique
    expect(new Set(pack.items.map((i) => i.id)).size).toBe(pack.items.length);
    // no outside feed was asked
    expect(calls).toEqual([]);
    expect(pack.coverage.inputs.map((i) => i.name)).not.toContain("StockTwits sentiment");
  });

  it("says technical indicators are missing when the desk has no prices and the provider is down", async () => {
    process.env.SIGNAL_FEEDS = "none";
    resetConfig();
    vi.stubGlobal("fetch", async () => new Response("down", { status: 503 }));
    await company("ZZZZ");

    const pack = await buildEvidence((await findCompany("ZZZZ"))!, OWNER);
    expect(pack.items.some((i) => i.kind === "technical")).toBe(false);
    expect(pack.coverage.inputs).toContainEqual({ name: "technical indicators", present: false });
  });

  it("adds StockTwits counts and Polymarket odds when those feeds are on, and reuses them on the next build", async () => {
    process.env.SIGNAL_FEEDS = "stocktwits,polymarket";
    resetConfig();
    const calls = stubNetwork();
    await seedPrices(await company("AAPL"));
    const aapl = (await findCompany("AAPL"))!;

    const first = await buildEvidence(aapl, OWNER);
    expect(first.items.filter((i) => i.kind === "social").map((i) => i.value)).toEqual([10, 7, 3, 0.7]);
    const prediction = first.items.find((i) => i.kind === "prediction");
    expect(prediction).toMatchObject({ value: 0.62, unit: "ratio" });
    expect(prediction!.label).toContain("Will the Fed cut rates in December?");
    expect(first.coverage.inputs).toContainEqual({ name: "StockTwits sentiment", present: true });
    expect(first.coverage.inputs).toContainEqual({ name: "Polymarket odds", present: true });

    const fetchedOnce = calls.length;
    expect(fetchedOnce).toBeGreaterThan(0);

    // the second build reads the stored snapshots: same evidence, same hash, no new requests
    const second = await buildEvidence(aapl, OWNER);
    expect(calls.length).toBe(fetchedOnce);
    expect(second.hash).toBe(first.hash);
  });

  it("builds the pack without StockTwits when it is blocked, and says so", async () => {
    process.env.SIGNAL_FEEDS = "stocktwits";
    resetConfig();
    vi.stubGlobal("fetch", async () => new Response("Just a moment...", { status: 403, statusText: "Forbidden" }));
    await seedPrices(await company("AAPL"));

    const pack = await buildEvidence((await findCompany("AAPL"))!, OWNER);
    expect(pack.items.some((i) => i.kind === "social")).toBe(false);
    expect(pack.coverage.inputs).toContainEqual({ name: "StockTwits sentiment", present: false });
    expect(pack.items.some((i) => i.kind === "technical")).toBe(true);
  });
});
