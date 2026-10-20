import { DRIFT_RULES, type DriftRead } from "../earnings/drift";
import type { EvidenceItem } from "./evidence";

/* ---------------------------------------------------------------------------
   The latest quarter's earnings surprise and the market's reaction to it, as
   evidence items.

   Every figure becomes a numbered item the fact checker can test a model's
   number against. The readings ("beat", "confirmed") are decided by code from
   those same figures and carry no number of their own, and nothing here says
   what the stock will do: post-earnings drift is a documented tendency, not a
   forecast, and the notes say so.
--------------------------------------------------------------------------- */

type Item = Omit<EvidenceItem, "id">;

const SURPRISE_NOTE: Record<string, string> = {
  beat: "beat: earnings per share rose from a year earlier by more than their usual variation",
  miss: "miss: earnings per share fell from a year earlier by more than their usual variation",
  "in line": "in line: the change in earnings per share from a year earlier is within its usual variation",
  unscaled: "not scored: the desk holds too few earlier quarters to judge how unusual the change is",
};

const SETUP_NOTE: Record<string, string> = {
  confirmed: "confirmed: the stock moved the same way as the surprise, the setup in which drift has been documented; documented historically, not a forecast",
  unconfirmed: "not confirmed: the stock did not move with the surprise, so there is no drift setup",
  none: "none: the surprise is in line, so there is nothing for the market to confirm",
  unmeasured: "unmeasured: the reaction could not be read",
};

export function earningsItems(d: DriftRead, source: EvidenceItem["source"]): Item[] {
  const { latest, reaction, reading, announcement } = d;
  if (d.status !== "measured" || !latest || !reading) return [];

  const items: Item[] = [];
  const asOf = latest.periodEnd;
  const add = (label: string, value: number | null, unit: EvidenceItem["unit"], on = asOf) => {
    if (value !== null && Number.isFinite(value)) items.push({ kind: "earnings", label, value, unit, asOf: on, source });
  };
  const note = (label: string, text: string) => items.push({ kind: "earnings", label, text, asOf, source });

  add("Diluted earnings per share, latest quarter", latest.eps, "usd");
  add("Diluted earnings per share, the same quarter a year earlier", latest.yearAgo, "usd");
  add("Change in diluted earnings per share from the same quarter a year earlier", latest.change, "usd");
  add("Standardised unexpected earnings (SUE): that change in units of how much it has usually varied, no analyst estimates", latest.sue, "index");
  note("Earnings surprise reading", SURPRISE_NOTE[reading.surprise]);

  if (announcement) {
    note(
      "Earnings announcement date",
      `announced ${announcement.on}, dated by ${announcement.dating === "release" ? "the 8-K earnings release" : "the periodic filing, which can trail the release by weeks"}`
    );
  }

  if (reaction) {
    const on = reaction.to;
    add("Stock return around the earnings announcement, close before to close after", reaction.stock, "ratio", on);
    // Without a market series covering the dates the "abnormal" return is just
    // the stock's own, and is not given that name.
    if (reaction.adjusted) {
      add("Market (S&P 500) return around the earnings announcement, same closes", reaction.market, "ratio", on);
      add("Abnormal return around the earnings announcement (stock return less the market's)", reaction.abnormal, "ratio", on);
      add("Abnormal return since the earnings reaction closed (stock return less the market's)", reaction.drift, "ratio", on);
    } else {
      add("Stock return since the earnings reaction closed, not adjusted for the market", reaction.drift, "ratio", on);
    }
    add("Sessions since the earnings reaction closed", reaction.sessionsSince, "count", on);
    add("Sessions in the window in which post-earnings drift has been documented", DRIFT_RULES.window, "count", on);
    note("Earnings reaction reading", SETUP_NOTE[reading.setup]);
  }

  return items;
}
