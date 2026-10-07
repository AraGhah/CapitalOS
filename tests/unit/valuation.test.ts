import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { valueAccount, type ValuationInput } from "../../lib/valuation";
import { FxTable } from "../../lib/fx";

const D = (n: number | string) => new Decimal(n);
const at = (date: string) => new Date(`${date}T12:00:00Z`);
const closes = (rows: Array<[string, number]>) => rows.map(([date, c]) => ({ date, close: D(c) }));

function input(over: Partial<ValuationInput>): ValuationInput {
  return {
    baseCurrency: "USD",
    tracksCash: false,
    today: "2026-01-05",
    companies: new Map([["acme", { ticker: "ACME", name: "Acme", currency: "USD" }]]),
    trades: [],
    cash: [],
    splits: new Map(),
    prices: new Map(),
    dividends: new Map(),
    benchmark: null,
    fx: FxTable.fromSeries({}),
    ...over,
  };
}

describe("account valuation (FIN-01)", () => {
  it("values positions and measures a time-weighted gain", () => {
    const v = valueAccount(
      input({
        trades: [{ companyId: "acme", side: "buy", qty: D(10), price: D(100), fees: D(0), currency: "USD", executedAt: at("2026-01-01") }],
        prices: new Map([["acme", closes([["2026-01-01", 100], ["2026-01-02", 105], ["2026-01-05", 110]])]]),
      })
    );
    expect(v.totalValue.toNumber()).toBe(1100);
    expect(v.twr.cumulative).toBeCloseTo(0.1, 10);
    expect(v.holdings[0].unrealizedPL.toNumber()).toBe(100);
    expect(v.holdings[0].weight.toNumber()).toBe(1);
  });

  it("restates a pre-split purchase in today's shares", () => {
    const v = valueAccount(
      input({
        trades: [{ companyId: "acme", side: "buy", qty: D(10), price: D(800), fees: D(0), currency: "USD", executedAt: at("2026-01-01") }],
        splits: new Map([["acme", [{ date: "2026-01-03", ratio: D(4) }]]]),
        prices: new Map([["acme", closes([["2026-01-01", 200], ["2026-01-05", 210]])]]),
      })
    );
    expect(v.holdings[0].qty.toNumber()).toBe(40);
    expect(v.holdings[0].avgCost.toNumber()).toBe(200);
    expect(v.totalValue.toNumber()).toBe(8400);
  });

  it("counts dividends on the shares held at the ex-date as return", () => {
    const v = valueAccount(
      input({
        trades: [{ companyId: "acme", side: "buy", qty: D(10), price: D(100), fees: D(0), currency: "USD", executedAt: at("2026-01-01") }],
        prices: new Map([["acme", closes([["2026-01-01", 100]])]]),
        dividends: new Map([["acme", [{ exDate: "2026-01-03", amount: D(2), basis: "as_paid" }]]]),
      })
    );
    expect(v.dividendIncome.toNumber()).toBe(20);
    expect(v.twr.cumulative).toBeCloseTo(0.02, 10);
  });

  it("values a US stock in a Canadian account at each day's rate, with cost at the trade-day rate", () => {
    const fx = FxTable.fromSeries({
      USD: [
        { date: "2026-01-01", rate: D("1.30") },
        { date: "2026-01-05", rate: D("1.40") },
      ],
    });
    const v = valueAccount(
      input({
        baseCurrency: "CAD",
        fx,
        trades: [{ companyId: "acme", side: "buy", qty: D(10), price: D(100), fees: D(0), currency: "USD", executedAt: at("2026-01-01") }],
        prices: new Map([["acme", closes([["2026-01-01", 100]])]]),
      })
    );
    // the stock did not move; the dollar did
    expect(v.totalValue.toNumber()).toBe(1400);
    expect(v.holdings[0].costBasis.toNumber()).toBe(1300);
    expect(v.holdings[0].unrealizedPL.toNumber()).toBe(100);
    expect(v.twr.cumulative).toBeCloseTo(1.4 / 1.3 - 1, 10);
  });

  it("in a cash-tracking account, deposits and withdrawals do not move the return", () => {
    const v = valueAccount(
      input({
        tracksCash: true,
        cash: [
          { kind: "deposit", amount: D(1000), currency: "USD", occurredAt: at("2026-01-01") },
          { kind: "deposit", amount: D(5000), currency: "USD", occurredAt: at("2026-01-03") },
          { kind: "withdrawal", amount: D(500), currency: "USD", occurredAt: at("2026-01-04") },
        ],
        trades: [{ companyId: "acme", side: "buy", qty: D(10), price: D(100), fees: D(0), currency: "USD", executedAt: at("2026-01-01") }],
        prices: new Map([["acme", closes([["2026-01-01", 100], ["2026-01-02", 110]])]]),
      })
    );
    // 1000 → 1100 on day two, then only flows: 10%
    expect(v.twr.cumulative).toBeCloseTo(0.1, 10);
    expect(v.totalValue.toNumber()).toBe(1100 + 4500);
    expect(v.cash).toEqual([{ currency: "USD", amount: D(4500), amountBase: D(4500) }]);
    expect(v.netContributions.toNumber()).toBe(5500);
  });

  it("warns about a negative cash balance instead of hiding it", () => {
    const v = valueAccount(
      input({
        tracksCash: true,
        cash: [{ kind: "deposit", amount: D(100), currency: "USD", occurredAt: at("2026-01-01") }],
        trades: [{ companyId: "acme", side: "buy", qty: D(10), price: D(100), fees: D(0), currency: "USD", executedAt: at("2026-01-01") }],
        prices: new Map([["acme", closes([["2026-01-01", 100]])]]),
      })
    );
    expect(v.warnings.some((w) => /negative/.test(w))).toBe(true);
  });

  it("flags stale prices", () => {
    const v = valueAccount(
      input({
        today: "2026-02-01",
        trades: [{ companyId: "acme", side: "buy", qty: D(1), price: D(100), fees: D(0), currency: "USD", executedAt: at("2026-01-01") }],
        prices: new Map([["acme", closes([["2026-01-02", 100]])]]),
      })
    );
    expect(v.holdings[0].stale).toBe(true);
  });
});
