import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { decide } from "../../lib/decision/decide";
import type { RecordedDecision } from "../../lib/decision/store";
import { baseInput, dims, dropOn, measuredBook, strongCommittee } from "./decision-fixtures";

// The panel's data layer and its client button are not what is under test.
vi.mock("@/lib/decision/data", () => ({ decideForRun: async () => ({}) }));
vi.mock("@/lib/decision/store", () => ({ listDecisions: async () => [] }));
vi.mock("@/app/components/RecordDecision", () => ({ RecordDecision: () => createElement("button", null, "Record this decision") }));

const { DecisionView } = await import("../../app/components/DecisionPanel");

const render = (decision: ReturnType<typeof decide>, history: RecordedDecision[] = []) =>
  renderToStaticMarkup(createElement(DecisionView, { decision, history, runId: "00000000-0000-4000-8000-000000000001" }));

describe("DecisionView", () => {
  it("shows the rating ladder with the rating lit, the action, and the headline", () => {
    const html = render(decide(baseInput()));
    expect(html).toContain("Decision");
    expect(html).toContain("no model called");
    expect(html).toContain('class="on up"');
    expect(html).toContain(">Buy</span>");
    expect(html).toContain("buy 80 shares of TEST");
    expect(html).toContain("Record this decision");
  });

  it("shows the plan: entry, stop and the reward levels as planning arithmetic", () => {
    const html = render(decide(baseInput()));
    expect(html).toContain("The plan");
    expect(html).toContain("100.00 USD");
    expect(html).toContain("95.00");
    expect(html).toContain("Reward = 1.5× the risk");
    expect(html).toContain("107.50");
    expect(html).toContain("not a forecast");
  });

  it("shows the size: every ceiling, the lowest marked, and the shares", () => {
    const html = render(decide(baseInput()));
    expect(html).toContain("Ceiling: risk budget");
    expect(html).toContain("Ceiling: position cap (lowest)");
    expect(html).toContain("8,000 USD");
    expect(html).toContain("Shares to buy");
  });

  it("explains how the rating was reached, step by step", () => {
    const decision = decide(baseInput({ rating: strongCommittee({ confidence: { score: 0.4, label: "Low" } }) }));
    const html = render(decision);
    expect(html).toContain("How the rating was reached");
    expect(html).toContain("Buy → Hold");
    expect(html).toContain("(confidence)");
    expect(html).toContain("The committee&#x27;s scores alone would have given Buy");
  });

  it("puts a blocker where it cannot be missed", () => {
    const html = render(
      decide(baseInput({ checklist: { level: "not_ready", headline: "Not ready to buy: time horizon fails.", blocking: ["Time horizon"], unverified: [], risks: [] } }))
    );
    expect(html).toContain('<p class="alert">Not ready to buy: time horizon fails.</p>');
    expect(html).toContain("Avoid");
  });

  it("shows a sale with no plan table", () => {
    const html = render(
      decide(baseInput({ rating: { dimensions: dims({}, -2), confidence: { score: 0.8, label: "High" }, unverifiedFigures: [] }, portfolio: { holdingsValue: 10_000, heldValue: 10_000, heldQty: 100, sectorValue: null } }))
    );
    expect(html).toContain("sell your 100 shares of TEST");
    expect(html).toContain("Shares to sell");
    expect(html).not.toContain("The plan");
  });

  it("lists the decisions already recorded for the stock", () => {
    const history: RecordedDecision[] = [
      { id: "a", ticker: "TEST", runId: null, createdAt: "2026-10-01T12:00:00.000Z", rating: "overweight", action: "buy", refPrice: 91.5, priceAsOf: "2026-10-01", headline: "" },
    ];
    const html = render(decide(baseInput()), history);
    expect(html).toContain("Recorded decisions");
    expect(html).toContain("2026-10-01");
    expect(html).toContain("Overweight");
    expect(html).toContain("at 91.50");
  });

  it("links to the checklist it was judged against", () => {
    expect(render(decide(baseInput()))).toContain('href="/research/TEST#checklist"');
  });

  it("shows no risk debate when there was none", () => {
    expect(render(decide(baseInput()))).not.toContain("The risk debate");
  });

  describe("the risk debate", () => {
    // a stock whose bad day is 8%: the conservative seat cuts the position, the neutral seat (medium tolerance) too
    const debated = () => decide(baseInput({ avgDollarVolume: 5_000_000, book: measuredBook({ candidate: dropOn(0.08), market: dropOn(0.08) }) }));

    it("sets the three seats side by side, with the person's own lit and the position each would take", () => {
      const html = render(debated());
      expect(html).toContain("The risk debate");
      expect(html).toContain("Conservative");
      expect(html).toContain("Neutral · yours");
      expect(html).toContain("Aggressive");
      expect(html).toContain("Loss on a bad day");
      expect(html).toContain("Market sensitivity");
      expect(html).toContain("Overlap with your holdings");
      expect(html).toContain("Time to exit");
      expect(html).toContain("96 shared sessions to 2026-10-20");
      // 8,000 × 8% = 640 = 0.64% of 100,000, against the 0.20 / 0.35 / 0.60% bars
      expect(html).toContain("0.64%");
      expect(html).toContain("bar 0.35%");
      expect(html).toContain("Reduces");
      expect(html).toContain("Approves");
    });

    it("says what the size was cut to and why", () => {
      const html = render(debated());
      expect(html).toContain("Cut by the neutral risk seat to");
      expect(html).toContain("4,375 USD");
      expect(html).toContain("the loss it adds on a bad day");
    });

    it("lays out each seat's case, for and against, the person's seat open", () => {
      const html = render(debated());
      expect(html).toContain("<strong>For</strong>");
      expect(html).toContain("<strong>Against</strong>");
      expect(html).toContain("rate TEST Buy");
      // only the person's own seat is open by default
      expect(html.match(/<details open=""/g)?.length).toBeGreaterThanOrEqual(1);
    });

    it("says plainly when the portfolio could not be measured", () => {
      const html = render(decide(baseInput({ book: { status: "unmeasured", reason: "no price history could be loaded for TEST" } })));
      expect(html).toContain("The portfolio could not be measured: no price history could be loaded for TEST.");
      expect(html).toContain("not measured");
    });
  });
});
