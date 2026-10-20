import { describe, expect, it } from "vitest";
import { decide } from "../../lib/decision/decide";
import { baseInput, dims, snapshot, strongCommittee } from "./decision-fixtures";

const holding = (qty: number, price = 100) => ({ holdingsValue: qty * price, heldValue: qty * price, heldQty: qty, sectorValue: null });
const weak = { dimensions: dims({}, -2), confidence: { score: 0.8, label: "High" as const }, unverifiedFigures: [] };

describe("a buy", () => {
  it("is a buy of 80 shares at 100 with a stop at 95 for a clean, confident committee", () => {
    const d = decide(baseInput());
    expect(d.rating.final).toBe("buy");
    expect(d.action).toBe("buy");
    expect(d.blockers).toEqual([]);
    expect(d.plan.side).toBe("enter");
    expect(d.plan.entry?.price).toBe(100);
    expect(d.plan.stop?.price).toBe(95);
    expect(d.sizing.binding).toBe("position cap");
    expect(d.sizing.shares).toBe(80);
    expect(d.headline).toBe("Buy: buy 80 shares of TEST at about 100.00 (about 8,000 USD), stop 95.00, taking the position to 8.0% of your capital.");
  });

  it("is an add when the stock is already held, for the difference only", () => {
    // 20 shares held: capital is 2,000 held + 98,000 set aside = 100,000; target 8,000; 6,000 more is 60 shares
    const d = decide(baseInput({ portfolio: holding(20), profile: { tolerance: "medium", plannedSize: null, investableAmount: 98_000, maxLossShare: null } }));
    expect(d.action).toBe("add");
    expect(d.sizing.shares).toBe(60);
  });

  it("is half the size for an overweight", () => {
    const d = decide(baseInput({ rating: strongCommittee({ unverifiedFigures: ["12%"] }) }));
    expect(d.rating.final).toBe("overweight");
    expect(d.action).toBe("buy");
    expect(d.sizing.shares).toBe(40);
  });

  it("waits for a pullback when the stock is stretched, and sizes from the pullback price", () => {
    // entry 96, stop 91, risk 5.208% of the entry; position cap 8,000 still binds -> floor(8000 / 96) = 83
    const d = decide(baseInput({ technical: snapshot({ readings: { ...snapshot().readings, rsiZone: "overbought" }, rsi14: 75 }) }));
    expect(d.plan.entry).toMatchObject({ price: 96, kind: "pullback" });
    expect(d.sizing.shares).toBe(83);
    expect(d.headline).toContain("at about 96.00 (on a pullback)");
  });

  it("is a hold when the plan asks for no more than is held", () => {
    const d = decide(baseInput({ portfolio: holding(100), profile: { tolerance: "medium", plannedSize: null, investableAmount: 90_000, maxLossShare: null } }));
    // capital 100,000, target 8,000, held 10,000
    expect(d.action).toBe("hold");
    expect(d.cautions.join(" ")).toContain("no larger than what you hold");
  });

  it("is a watch, with the reason, when the position cannot be sized", () => {
    const d = decide(baseInput({ profile: { tolerance: "medium", plannedSize: null, investableAmount: null, maxLossShare: null } }));
    expect(d.rating.final).toBe("buy");
    expect(d.sizing.targetValue).toBeNull();
    expect(d.action).toBe("watch");
    expect(d.cautions.join(" ")).toContain("could not be sized");
  });
});

describe("the person comes before the stock", () => {
  it("never buys while the checklist says not ready", () => {
    const headline = "Not ready to buy: emergency savings fails — this is about your situation, not the stock.";
    const d = decide(
      baseInput({ checklist: { level: "not_ready", headline, blocking: ["Emergency savings"], unverified: [], risks: [] } })
    );
    expect(d.rating.final).toBe("buy");
    expect(d.action).toBe("avoid");
    expect(d.blockers).toEqual([headline]);
    expect(d.plan.side).toBe("none");
    expect(d.sizing.shares).toBe(0);
    expect(d.headline).toContain("Buy, but not for you right now");
  });

  it("keeps a held stock and adds nothing while the checklist says not ready", () => {
    const d = decide(
      baseInput({
        portfolio: holding(20),
        checklist: { level: "not_ready", headline: "Not ready", blocking: ["Time horizon"], unverified: [], risks: [] },
      })
    );
    expect(d.action).toBe("hold");
    expect(d.sizing.shares).toBe(0);
    expect(d.headline).toContain("keep your TEST and add nothing");
  });

  it("refuses to add while a rule in an open thesis is breached", () => {
    const d = decide(baseInput({ portfolio: holding(20), thesisBreached: true }));
    expect(d.action).toBe("hold");
    expect(d.blockers.join(" ")).toContain("thesis");
  });

  it("recommends no purchase at all when the checklist could not be built", () => {
    const d = decide(baseInput({ checklist: null }));
    expect(d.action).toBe("avoid");
    expect(d.blockers[0]).toContain("could not be built");
  });

  it("halves the size, and says why, while the checklist is incomplete", () => {
    const d = decide(
      baseInput({
        checklist: { level: "incomplete", headline: "Checklist incomplete", blocking: [], unverified: ["Emergency savings", "Time horizon"], risks: [] },
      })
    );
    expect(d.action).toBe("buy");
    expect(d.sizing.shares).toBe(40);
    expect(d.cautions.join(" ")).toContain("2 checklist questions are unanswered");
  });

  it("does not let the checklist stop a sale", () => {
    const d = decide(
      baseInput({
        rating: weak,
        portfolio: holding(100),
        checklist: { level: "not_ready", headline: "Not ready", blocking: ["Time horizon"], unverified: [], risks: [] },
      })
    );
    expect(d.action).toBe("sell");
    expect(d.blockers).toEqual([]);
  });
});

describe("the other actions", () => {
  it("sells everything held on a sell rating, with no entry or stop", () => {
    const d = decide(baseInput({ rating: weak, portfolio: holding(100) }));
    expect(d.rating.final).toBe("sell");
    expect(d.action).toBe("sell");
    expect(d.plan.side).toBe("exit");
    expect(d.plan.entry).toBeNull();
    expect(d.sizing.shares).toBe(-100);
    expect(d.headline).toBe("Sell: sell your 100 shares of TEST.");
  });

  it("stays out of a stock it would sell when it is not held", () => {
    const d = decide(baseInput({ rating: weak }));
    expect(d.action).toBe("avoid");
    expect(d.plan.side).toBe("none");
    expect(d.headline).toBe("Sell: stay out of TEST.");
  });

  it("trims half of a held position on an underweight", () => {
    const d = decide(baseInput({ rating: { ...weak, dimensions: dims({}, -0.6) }, portfolio: holding(100) }));
    expect(d.rating.final).toBe("underweight");
    expect(d.action).toBe("trim");
    expect(d.sizing.shares).toBe(-50);
    expect(d.headline).toBe("Underweight: trim 50 of your 100 shares of TEST, half the position.");
  });

  it("holds what is held on a hold, and watches what is not", () => {
    const hold = { ...strongCommittee(), dimensions: dims({}, 0) };
    expect(decide(baseInput({ rating: hold, portfolio: holding(10) })).action).toBe("hold");
    const watch = decide(baseInput({ rating: hold }));
    expect(watch.action).toBe("watch");
    expect(watch.headline).toBe("Hold: TEST is not a purchase today. Keep it on the watchlist.");
  });

  it("turns a strong score into a hold, not a buy, at Low confidence", () => {
    const d = decide(baseInput({ rating: strongCommittee({ confidence: { score: 0.4, label: "Low" } }) }));
    expect(d.rating.raw).toBe("buy");
    expect(d.rating.final).toBe("hold");
    expect(d.rating.steps[0].rule).toBe("confidence");
    expect(d.action).toBe("watch");
  });
});

describe("the whole decision", () => {
  it("is the same decision every time for the same inputs, and survives JSON", () => {
    const input = baseInput({ portfolio: holding(20) });
    const first = decide(input);
    expect(decide(structuredClone(input))).toEqual(first);
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
  });

  it("carries the currency, the run and the checklist it was drawn against", () => {
    const d = decide(baseInput({ baseCurrency: "CAD", fxToBase: 1.35 }));
    expect(d.currency).toEqual({ listing: "USD", base: "CAD", fxToBase: 1.35 });
    expect(d.runId).toBe("00000000-0000-4000-8000-000000000001");
    expect(d.checklist?.level).toBe("ready");
    // 8,000 CAD at 135 CAD a share
    expect(d.sizing.shares).toBe(59);
    expect(d.headline).toContain("(about 7,965 CAD)");
  });
});
