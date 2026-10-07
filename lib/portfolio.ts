import Decimal from "decimal.js";

export interface Txn {
  side: "buy" | "sell";
  qty: Decimal.Value;
  price: Decimal.Value;
  fees: Decimal.Value;
  executedAt: Date;
}

export interface Position {
  qty: Decimal;
  avgCost: Decimal;
  realizedPL: Decimal;
  costEverInvested: Decimal;
  // Shares sold that the ledger never held. The write path refuses these, so a
  // non-zero value means a row predates that check (or the data was edited by
  // hand); it is reported, never silently absorbed.
  oversold: Decimal;
}

// Time order, and at the same moment a buy before a sell: a trade entered with a
// date only lands at noon, and buying and selling on one day is a round trip,
// not a short. lib/ledger validates writes with exactly this order.
export function compareTxns(
  a: { executedAt: Date; side: "buy" | "sell" },
  b: { executedAt: Date; side: "buy" | "sell" }
): number {
  const byTime = a.executedAt.getTime() - b.executedAt.getTime();
  if (byTime !== 0) return byTime;
  if (a.side === b.side) return 0;
  return a.side === "buy" ? -1 : 1;
}

const ZERO = new Decimal(0);

// average cost method: a sell doesn't change avgCost, only qty and realizedPL
export function buildPosition(txns: Txn[]): Position {
  const sorted = [...txns].sort(compareTxns);

  let qty = ZERO;
  let avgCost = ZERO;
  let realizedPL = ZERO;
  let costEverInvested = ZERO;
  let oversold = ZERO;

  for (const t of sorted) {
    const txQty = new Decimal(t.qty);
    const txPrice = new Decimal(t.price);
    const txFees = new Decimal(t.fees);

    if (t.side === "buy") {
      const cost = txQty.mul(txPrice).add(txFees);
      const newQty = qty.add(txQty);
      avgCost = newQty.isZero() ? ZERO : avgCost.mul(qty).add(cost).div(newQty);
      qty = newQty;
      costEverInvested = costEverInvested.add(cost);
    } else {
      // Only shares actually held can be sold. The excess is not turned into a
      // short the ledger never recorded; it is counted, so the page can say the
      // ledger is inconsistent instead of quietly showing a tidy position.
      const sold = Decimal.min(txQty, qty);
      if (txQty.gt(qty)) oversold = oversold.add(txQty.sub(qty));
      if (sold.lte(0)) continue;
      const proceeds = sold.mul(txPrice).sub(txFees);
      realizedPL = realizedPL.add(proceeds.sub(avgCost.mul(sold)));
      qty = qty.sub(sold);
      if (qty.isZero()) avgCost = ZERO;
    }
  }

  return { qty, avgCost, realizedPL, costEverInvested, oversold };
}
