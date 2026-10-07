import { route } from "@/lib/http/route";
import { parseJson } from "@/lib/http/errors";
import { AccountPatch } from "@/lib/http/schemas";
import { getAccount, updateAccount } from "@/lib/cash";
import { valuationFor } from "@/lib/holdings";
import { enqueue } from "@/lib/jobs/queue";

export const dynamic = "force-dynamic";

// The account and its valuation: value, cash by currency, time- and
// money-weighted returns, dividend income, in its base currency.
export const GET = route(async (_req, { actor }) => {
  const [account, v] = await Promise.all([getAccount(actor), valuationFor(actor.accountId)]);
  return Response.json({
    account,
    valuation: {
      asOf: v.asOf,
      baseCurrency: v.baseCurrency,
      totalValue: v.totalValue.toString(),
      positionsValue: v.positionsValue.toString(),
      cash: v.cash.map((c) => ({ currency: c.currency, amount: c.amount.toString(), amountBase: c.amountBase.toString() })),
      timeWeightedReturn: v.twr,
      moneyWeightedReturn: v.mwr,
      dividendIncome: v.dividendIncome.toString(),
      netContributions: v.netContributions.toString(),
      warnings: v.warnings,
      integrity: v.integrity,
    },
  });
});

export const PATCH = route(async (req, { actor }) => {
  const patch = await parseJson(req, AccountPatch);
  await updateAccount(actor, patch);
  // A new base currency needs its exchange rates; fetched in the background.
  if (patch.baseCurrency) await enqueue({ kind: "ingest.fx", userId: null, dedupeKey: "fx", maxAttempts: 3 });
  return Response.json(await getAccount(actor));
});
