import { readDrift, type Bar, type DriftRead, type QuarterFiling } from "../../lib/earnings/drift";

/* ---------------------------------------------------------------------------
   A company that has reported five quarters, the last with EPS up 0.16 on a
   year earlier against changes of 0.08, 0.12, 0.08 and 0.12 before it: a
   surprise of 2.598 deviations (worked by hand in earnings-drift.test.ts). The
   stock rose 5% and the market 1% across the announcement, so the market
   agreed with the surprise.
--------------------------------------------------------------------------- */

const plus = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

const ENDS = ["2025-03-31", "2025-06-30", "2025-09-30", "2025-12-31", "2026-03-31"];
const CHANGES = [0.08, 0.12, 0.08, 0.12, 0.16];

export function filings(): QuarterFiling[] {
  return ENDS.map((periodEnd, i) => ({
    accession: `A-${periodEnd}`,
    form: "10-Q",
    filedOn: i === 4 ? "2026-05-10" : plus(periodEnd, 40),
    periodEnd,
    current: { eps: 1 + CHANGES[i], netIncome: null, shares: null },
    yearAgo: { eps: 1, netIncome: null, shares: null },
  }));
}

// trading days from a start date, skipping weekends
function sessions(from: string, closes: number[]): Bar[] {
  const out: Bar[] = [];
  let date = from;
  for (const close of closes) {
    while ([0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay())) date = plus(date, 1);
    out.push({ date, close });
    date = plus(date, 1);
  }
  return out;
}

// 2026-04-20 is a Monday; the announcement on the 28th is the 7th session
export const stock = (): Bar[] => sessions("2026-04-20", [100, 100, 100, 100, 100, 100, 101, 105, 106, 107]);
export const market = (): Bar[] => sessions("2026-04-20", [400, 400, 400, 400, 400, 400, 401, 404, 405, 406]);

export function measuredRead(over: Partial<Parameters<typeof readDrift>[0]> = {}): DriftRead {
  return readDrift({ quarters: filings(), releases: ["2026-04-28"], stock: stock(), market: market(), latestReport: null, ...over });
}
