import { describe, expect, it } from "vitest";
import fc from "fast-check";
import Decimal from "decimal.js";
import { replayPosition, type LedgerEntry } from "../../lib/ledger";
import { buildPosition } from "../../lib/portfolio";

const at = (date: string) => new Date(`${date}T12:00:00Z`);
const e = (side: "buy" | "sell", qty: number, date: string, seq = 0): LedgerEntry => ({
  side,
  qty: new Decimal(qty),
  executedAt: at(date),
  seq,
});

describe("replayPosition", () => {
  it("accepts a timeline that never goes below zero", () => {
    const r = replayPosition([e("buy", 10, "2026-10-01"), e("sell", 4, "2026-10-03"), e("sell", 6, "2026-10-05")]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.final.toNumber()).toBe(0);
  });

  // LED-01: 10 held on Oct 3 is true, but the Oct 5 sell already used them.
  it("refuses a backdated sell whose shares a later sell already used", () => {
    const r = replayPosition([e("buy", 10, "2026-10-01"), e("sell", 10, "2026-10-05"), e("sell", 10, "2026-10-03")]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.violation.shortfall.toNumber()).toBe(10);
      expect(r.violation.at.toISOString().slice(0, 10)).toBe("2026-10-05");
    }
  });

  it("treats a buy and a sell at the same moment as buy first", () => {
    const r = replayPosition([e("sell", 5, "2026-10-01", 1), e("buy", 5, "2026-10-01", 2)]);
    expect(r.ok).toBe(true);
  });

  it("never reports ok for a timeline whose running position dips below zero", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            side: fc.constantFrom<"buy" | "sell">("buy", "sell"),
            qty: fc.integer({ min: 1, max: 100 }),
            day: fc.integer({ min: 1, max: 28 }),
          }),
          { maxLength: 30 }
        ),
        (rows) => {
          const entries = rows.map((r, i) => e(r.side, r.qty, `2026-02-${String(r.day).padStart(2, "0")}`, i));
          const result = replayPosition(entries);
          // Independent check: sort the same way and walk it.
          const sorted = [...entries].sort(
            (a, b) =>
              a.executedAt.getTime() - b.executedAt.getTime() ||
              (a.side === b.side ? 0 : a.side === "buy" ? -1 : 1) ||
              a.seq - b.seq
          );
          let running = 0;
          let negative = false;
          for (const s of sorted) {
            running += (s.side === "buy" ? 1 : -1) * s.qty.toNumber();
            if (running < 0) negative = true;
          }
          return result.ok === !negative;
        }
      )
    );
  });
});

describe("buildPosition", () => {
  it("flags an oversell instead of hiding it", () => {
    const p = buildPosition([
      { side: "buy", qty: 10, price: 100, fees: 0, executedAt: at("2026-10-01") },
      { side: "sell", qty: 15, price: 110, fees: 0, executedAt: at("2026-10-02") },
    ]);
    expect(p.qty.toNumber()).toBe(0);
    expect(p.oversold.toNumber()).toBe(5);
  });

  it("conserves cost under average cost: sold basis plus remaining basis equals total cost", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ qty: fc.integer({ min: 1, max: 50 }), price: fc.integer({ min: 1, max: 500 }) }), {
          minLength: 1,
          maxLength: 10,
        }),
        fc.integer({ min: 1, max: 600 }),
        (buys, sellPrice) => {
          const txns: Array<{ side: "buy" | "sell"; qty: number; price: number; fees: number; executedAt: Date }> = buys.map(
            (b, i) => ({ side: "buy", qty: b.qty, price: b.price, fees: 0, executedAt: new Date(Date.UTC(2026, 0, 1 + i)) })
          );
          const total = buys.reduce((s, b) => s + b.qty, 0);
          const sold = Math.floor(total / 2);
          if (sold > 0) txns.push({ side: "sell", qty: sold, price: sellPrice, fees: 0, executedAt: new Date(Date.UTC(2026, 1, 1)) });
          const p = buildPosition(txns);
          const cost = buys.reduce((s, b) => s.add(new Decimal(b.qty).mul(b.price)), new Decimal(0));
          const proceeds = new Decimal(sold).mul(sellPrice);
          const soldBasis = proceeds.sub(p.realizedPL);
          const remainingBasis = p.avgCost.mul(p.qty);
          return soldBasis.add(remainingBasis).sub(cost).abs().lt("1e-9") && p.oversold.isZero();
        }
      )
    );
  });
});
