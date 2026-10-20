import { RATING_LABEL } from "../decision/rating";
import type { RecordedCall } from "../track/record";
import type { Outcome } from "../track/settle";
import type { EvidenceItem } from "./evidence";

/* ---------------------------------------------------------------------------
   How this person's earlier decisions on the company turned out, as evidence
   items.

   TradingAgents hands each run the lessons of the decisions it resolved on the
   same stock. This hands over the figures behind them and nothing else: the
   rating the desk gave, and what the stock then did against the S&P 500 over the
   horizon that has closed. Each figure is a numbered item the fact checker can
   test a model's number against. No lesson is drawn for the committee, and the
   first item says what the others are not.

   A decision is quoted at the longest horizon that was measured (the 60-session
   figure once there is one, otherwise the 20, otherwise the 5), and only
   when it was measured: an excluded decision has no figures to quote. At most
   three decisions, newest first, so a long history does not crowd the pack.

   The items carry no coverage input: a stock the person has never decided on is
   not missing evidence, and counting it as missing would lower every first
   committee's confidence.
--------------------------------------------------------------------------- */

type Item = Omit<EvidenceItem, "id">;

const VERDICT_NOTE: Record<Outcome["verdict"], string> = {
  right: "right: the stock moved against the market in the direction the rating pointed, by more than the horizon's noise band",
  wrong: "wrong: the stock moved against the market opposite to the rating, by more than the horizon's noise band",
  flat: "too close to call: the stock's move against the market was inside the horizon's noise band",
  no_claim: "no call: a hold does not say the stock will do better or worse than the market",
  excluded: "not measured",
};

// The longest horizon of a call that was measured.
function quoted(call: RecordedCall): Outcome | null {
  const measured = call.outcomes.filter((o) => o.verdict !== "excluded" && o.alpha !== null && o.stockReturn !== null && o.marketReturn !== null);
  return measured.sort((a, b) => b.horizon - a.horizon)[0] ?? null;
}

export function trackItems(calls: RecordedCall[], source: EvidenceItem["source"], limit = 3): Item[] {
  const items: Item[] = [];
  const picked = calls.flatMap((c) => {
    const o = quoted(c);
    return o ? [{ call: c, outcome: o }] : [];
  });
  if (picked.length === 0) return items;

  items.push({
    kind: "track",
    label: "The desk's own earlier decisions on this stock",
    text:
      `${Math.min(limit, picked.length)} earlier decision${picked.length === 1 ? "" : "s"} the person recorded on this stock, and what the stock did against the S&P 500 in the sessions after each. ` +
      "They describe what already happened; they do not say what the stock will do next, and a rating that was right once may not be again.",
    source,
  });

  for (const { call, outcome } of picked.slice(0, limit)) {
    const on = call.asOf ?? call.createdAt.slice(0, 10);
    const exit = outcome.exitDate ?? on;
    const tag = `${RATING_LABEL[call.rating]} decision of ${on}`;
    const over = `over the ${outcome.horizon} sessions after it`;
    items.push({ kind: "track", label: `Stock return ${over} (${tag})`, value: outcome.stockReturn as number, unit: "ratio", asOf: exit, source });
    items.push({ kind: "track", label: `S&P 500 return ${over} (${tag})`, value: outcome.marketReturn as number, unit: "ratio", asOf: exit, source });
    items.push({ kind: "track", label: `Return against the market ${over}: stock less S&P 500 (${tag})`, value: outcome.alpha as number, unit: "ratio", asOf: exit, source });
    items.push({ kind: "track", label: `How the ${tag} turned out at ${outcome.horizon} sessions`, text: VERDICT_NOTE[outcome.verdict], asOf: exit, source });
  }
  return items;
}

