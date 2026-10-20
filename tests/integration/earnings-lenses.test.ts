import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EarningsDriftPanel } from "../../app/components/EarningsDriftPanel";
import { LensesPanel } from "../../app/components/PersonasPanel";
import { GET as getEarnings } from "../../app/api/earnings/[ticker]/route";
import { GET as getLenses } from "../../app/api/personas/[ticker]/route";
import { buildEvidence } from "../../lib/ai/evidence";
import { findCompany } from "../../lib/company";
import { resetConfig } from "../../lib/config";
import { BENCHMARK_TICKER } from "../../lib/constants";
import { pool } from "../../lib/db";
import { company } from "./db";
import { call, signedInUser } from "./helpers";

const OWNER = { userId: "00000000-0000-0000-0000-000000000001", accountId: "00000000-0000-0000-0000-000000000001" };

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.SIGNAL_FEEDS;
  resetConfig();
});

/* ---------------------------------------------------------------------------
   Five quarters of diluted EPS, the last up 0.16 on a year earlier against
   changes of 0.08, 0.12, 0.08 and 0.12 before it (a surprise of 2.598
   deviations, worked by hand in tests/unit/earnings-drift.test.ts), announced
   on 2026-04-28. The stock rose 5% and the market 1% across the announcement.
--------------------------------------------------------------------------- */

const ENDS = ["2025-03-31", "2025-06-30", "2025-09-30", "2025-12-31", "2026-03-31"];
const CHANGES = [0.08, 0.12, 0.08, 0.12, 0.16];
const plus = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const yearBefore = (date: string) => `${Number(date.slice(0, 4)) - 1}${date.slice(4)}`;

async function seedQuarters(companyId: string) {
  for (const [i, periodEnd] of ENDS.entries()) {
    const { rows } = await pool.query(
      `INSERT INTO filings (company_id, accession, form_type, filed_at, period_end) VALUES ($1, $2, '10-Q', $3, $4) RETURNING id`,
      [companyId, `0000000000-26-00000${i}`, i === 4 ? "2026-05-10" : plus(periodEnd, 40), periodEnd]
    );
    for (const [end, eps] of [[periodEnd, 1 + CHANGES[i]], [yearBefore(periodEnd), 1]] as const) {
      await pool.query(
        `INSERT INTO fundamentals (company_id, period_end, fiscal_period, metric, value, filing_id) VALUES ($1, $2, 'Q', 'eps_diluted', $3, $4)`,
        [companyId, end, eps, rows[0].id]
      );
    }
  }
  await pool.query(`INSERT INTO earnings_releases (accession, company_id, announced_on) VALUES ('0000000000-26-100001', $1, '2026-04-28')`, [companyId]);
}

// 70 weekdays ending 2026-05-01, flat until the announcement and then up.
async function seedPrices(companyId: string, base: number, after: [number, number, number, number]) {
  let date = "2026-01-26";
  while (date <= "2026-05-01") {
    if (![0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay())) {
      const step = ["2026-04-28", "2026-04-29", "2026-04-30", "2026-05-01"].indexOf(date);
      const close = step === -1 ? base : after[step];
      await pool.query(`INSERT INTO prices_daily (company_id, date, open, high, low, close, volume) VALUES ($1, $2, $3, $3, $3, $3, 1000000)`, [companyId, date, close]);
    }
    date = plus(date, 1);
  }
}

async function seed(ticker = "EARN") {
  const id = await company(ticker);
  await seedQuarters(id);
  await seedPrices(id, 100, [101, 105, 106, 107]);
  await seedPrices(await company(BENCHMARK_TICKER), 400, [401, 404, 405, 406]);
  return id;
}

// The provider is down, so the stored closes are what is read.
const providerDown = () => vi.stubGlobal("fetch", async () => new Response("down", { status: 503 }));

type Drift = {
  status: string;
  latest: { sue: number; eps: number; yearAgo: number } | null;
  announcement: { on: string; dating: string } | null;
  reaction: { abnormal: number; adjusted: boolean } | null;
  reading: { surprise: string; setup: string } | null;
};

describe("GET /api/earnings/[ticker]", () => {
  it("reads the surprise, dates it by the 8-K and measures the reaction against the market", async () => {
    providerDown();
    await seed();
    const u = await signedInUser();
    const res = await call(getEarnings, { cookie: u.cookie, params: { ticker: "EARN" }, path: "/api/earnings/EARN" });
    expect(res.status).toBe(200);
    expect(res.res.headers.get("cache-control")).toBe("no-store");
    const { ticker, drift } = res.body as { ticker: string; drift: Drift };
    expect(ticker).toBe("EARN");
    expect(drift.status).toBe("measured");
    expect(drift.latest?.eps).toBeCloseTo(1.16, 6);
    expect(drift.latest?.yearAgo).toBe(1);
    expect(drift.latest?.sue).toBeCloseTo(2.598, 3);
    expect(drift.announcement).toEqual({ on: "2026-04-28", dating: "release" });
    expect(drift.reaction?.adjusted).toBe(true);
    expect(drift.reaction?.abnormal).toBeCloseTo(0.04, 6);
    expect(drift.reading).toMatchObject({ surprise: "beat", setup: "confirmed" });
  });

  it("dates the quarter by the 10-Q when no earnings release is stored, and says so", async () => {
    providerDown();
    const id = await seed();
    await pool.query(`DELETE FROM earnings_releases WHERE company_id = $1`, [id]);
    const u = await signedInUser();
    const { drift } = (await call(getEarnings, { cookie: u.cookie, params: { ticker: "EARN" } })).body as { drift: Drift };
    expect(drift.announcement).toEqual({ on: "2026-05-10", dating: "filing" });
    // the 10-Q came after the last stored session, so there is no reaction to read yet
    expect(drift.reaction).toBeNull();
    expect(drift.latest?.sue).toBeCloseTo(2.598, 3);
  });

  it("is unmeasured, not an error, for a company with no quarterly filings", async () => {
    providerDown();
    await company("BARE");
    const u = await signedInUser();
    const res = await call(getEarnings, { cookie: u.cookie, params: { ticker: "BARE" } });
    expect(res.status).toBe(200);
    expect((res.body as { drift: Drift }).drift.status).toBe("unmeasured");
  });

  it("is a 404 for a company the desk does not have, a 400 for a malformed ticker, and a 401 signed out", async () => {
    const u = await signedInUser();
    expect((await call(getEarnings, { cookie: u.cookie, params: { ticker: "NOPE" } })).status).toBe(404);
    expect((await call(getEarnings, { cookie: u.cookie, params: { ticker: "not a ticker!" } })).status).toBe(400);
    expect((await call(getEarnings, { params: { ticker: "EARN" } })).status).toBe(401);
  });
});

describe("GET /api/personas/[ticker]", () => {
  it("runs all eight lenses, and scores none of them on a company with no annual filings", async () => {
    providerDown();
    await company("LENS");
    const u = await signedInUser();
    const res = await call(getLenses, { cookie: u.cookie, params: { ticker: "LENS" }, path: "/api/personas/LENS" });
    expect(res.status).toBe(200);
    expect(res.res.headers.get("cache-control")).toBe("no-store");
    const body = res.body as { ticker: string; lenses: Array<{ id: string; fit: string }>; tally: Record<string, number> };
    expect(body.ticker).toBe("LENS");
    expect(body.lenses.map((l) => l.id)).toEqual(["graham", "buffett", "munger", "lynch", "fisher", "burry", "wood", "damodaran"]);
    // no data is never a pass: every lens says it cannot judge
    expect(body.lenses.every((l) => l.fit === "unscored")).toBe(true);
    expect(body.tally.unscored).toBe(8);
  });

  it("is a 404 for a company the desk does not have, and a 401 signed out", async () => {
    const u = await signedInUser();
    expect((await call(getLenses, { cookie: u.cookie, params: { ticker: "NOPE" } })).status).toBe(404);
    expect((await call(getLenses, { params: { ticker: "LENS" } })).status).toBe(401);
  });
});

describe("the evidence pack with the earnings surprise", () => {
  const build = async (ticker: string) => {
    process.env.SIGNAL_FEEDS = "none";
    resetConfig();
    providerDown();
    return buildEvidence((await findCompany(ticker))!, OWNER);
  };

  it("carries the surprise, the reaction and the drift, and counts the input as present", async () => {
    await seed();
    const pack = await build("EARN");
    const earnings = pack.items.filter((i) => i.kind === "earnings");
    expect(earnings.length).toBeGreaterThan(8);
    expect(earnings.find((i) => /SUE/.test(i.label))?.value).toBeCloseTo(2.598, 3);
    expect(earnings.find((i) => /^Abnormal return around/.test(i.label))?.value).toBeCloseTo(0.04, 6);
    expect(earnings.every((i) => i.source.kind === "computed")).toBe(true);
    expect(pack.coverage.inputs).toContainEqual({ name: "earnings surprise", present: true });
    expect(new Set(pack.items.map((i) => i.id)).size).toBe(pack.items.length);
  });

  it("says the earnings surprise is missing when no quarter can be read, without failing the pack", async () => {
    await company("BARE");
    const pack = await build("BARE");
    expect(pack.items.some((i) => i.kind === "earnings")).toBe(false);
    expect(pack.coverage.inputs).toContainEqual({ name: "earnings surprise", present: false });
  });

  it("builds the same pack twice", async () => {
    await seed();
    const first = await build("EARN");
    const second = await build("EARN");
    expect(second.hash).toBe(first.hash);
  });
});

describe("the research page panels over the stored data", () => {
  it("shows the earnings drift read from the filings, the 8-K and the closes", async () => {
    providerDown();
    const id = await seed();
    const html = renderToStaticMarkup(await EarningsDriftPanel({ company: { id, ticker: "EARN" } }));
    expect(html).toContain("quarter ended 2026-03-31");
    expect(html).toContain("from the 8-K, Item 2.02");
    expect(html).toContain("market confirmed it");
    expect(html).toContain("+4.0%");
    expect(html).toContain("prices_daily table");
  });

  it("says what to run when the desk holds no quarterly filings", async () => {
    providerDown();
    const id = await company("BARE");
    expect(renderToStaticMarkup(await EarningsDriftPanel({ company: { id, ticker: "BARE" } }))).toContain("npm run ingest-edgar");
  });

  it("shows all eight lenses, none of them scored, for a company with no annual filings", async () => {
    providerDown();
    const id = await company("LENS");
    const html = renderToStaticMarkup(await LensesPanel({ company: { id, ticker: "LENS", name: "LENS Inc", sector: "Technology" } }));
    expect(html.match(/<details class="lens"/g)).toHaveLength(8);
    expect(html).toContain("8 not enough data");
    expect(html).not.toContain("Fits");
  });
});
