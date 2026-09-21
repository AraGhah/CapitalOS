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
}

const ZERO = new Decimal(0);

// average cost method: a sell doesn't change avgCost, only qty and realizedPL
export function buildPosition(txns: Txn[]): Position {
  const sorted = [...txns].sort((a, b) => a.executedAt.getTime() - b.executedAt.getTime());

  let qty = ZERO;
  let avgCost = ZERO;
  let realizedPL = ZERO;
  let costEverInvested = ZERO;

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
      const proceeds = txQty.mul(txPrice).sub(txFees);
      const costRemoved = avgCost.mul(txQty);
      realizedPL = realizedPL.add(proceeds.sub(costRemoved));
      qty = qty.sub(txQty);
    }
  }

  return { qty, avgCost, realizedPL, costEverInvested };
}

export interface Holding {
  companyId: string;
  qty: Decimal;
  avgCost: Decimal;
  price: Decimal;
  costBasis: Decimal;
  marketValue: Decimal;
  unrealizedPL: Decimal;
  realizedPL: Decimal;
  weight: Decimal;
}

export function summarizeHoldings(
  positions: Map<string, Position>,
  prices: Map<string, Decimal>
): Holding[] {
  const open = [...positions.entries()].filter(([, p]) => p.qty.gt(0));

  const totalMarketValue = open.reduce((sum, [companyId, p]) => {
    const price = prices.get(companyId) ?? p.avgCost;
    return sum.add(p.qty.mul(price));
  }, ZERO);

  return open.map(([companyId, p]) => {
    const price = prices.get(companyId) ?? p.avgCost;
    const marketValue = p.qty.mul(price);
    const costBasis = p.avgCost.mul(p.qty);
    return {
      companyId,
      qty: p.qty,
      avgCost: p.avgCost,
      price,
      costBasis,
      marketValue,
      unrealizedPL: marketValue.sub(costBasis),
      realizedPL: p.realizedPL,
      weight: totalMarketValue.isZero() ? ZERO : marketValue.div(totalMarketValue),
    };
  });
}

// realized + unrealized gain over everything ever put in
export function totalReturn(positions: Map<string, Position>, prices: Map<string, Decimal>): Decimal {
  let realizedPL = ZERO;
  let unrealizedPL = ZERO;
  let costEverInvested = ZERO;

  for (const [companyId, p] of positions) {
    realizedPL = realizedPL.add(p.realizedPL);
    costEverInvested = costEverInvested.add(p.costEverInvested);
    if (p.qty.gt(0)) {
      const price = prices.get(companyId) ?? p.avgCost;
      unrealizedPL = unrealizedPL.add(p.qty.mul(price).sub(p.avgCost.mul(p.qty)));
    }
  }

  if (costEverInvested.isZero()) return ZERO;
  return realizedPL.add(unrealizedPL).div(costEverInvested);
}
