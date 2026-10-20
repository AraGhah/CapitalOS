import { describe, expect, it } from "vitest";
import { decide } from "../../lib/decision/decide";
import { DEBATE_RULES, SEAT_RULES, objection, riskDebate, type DebateInput, type RiskBook } from "../../lib/decision/risk-debate";
import { SESSIONS as N, baseInput, dropOn, measuredBook as measured } from "./decision-fixtures";

// The series come from decision-fixtures (dropOn: a 1-day 95% loss of exactly the drop). `alternating`
// is the market for the beta tests: +1% / −1%, so a series that is a multiple k of it has beta k.
const alternating = Array.from({ length: N }, (_, t) => (t % 2 === 0 ? 0.01 : -0.01));
const scaled = (k: number, xs: number[]) => xs.map((x) => x * k);

// 100,000 of capital, nothing held, a plan for 8,000, a liquid stock.
const debateInput = (over: Partial<DebateInput> = {}): DebateInput => ({
  ticker: "TEST",
  base: "USD",
  book: measured(),
  capital: 100_000,
  held: 0,
  proposed: 8_000,
  avgDollarVolume: 5_000_000,
  fxToBase: 1,
  tolerance: "medium",
  facts: { rating: "buy", composite: 2, confidence: "High", volatility: 0.3, maxDrawdown: -0.2, stress: 0.5, rsi: 58, trend: "uptrend" },
  ...over,
});

const seat = (d: ReturnType<typeof riskDebate>, name: "conservative" | "neutral" | "aggressive") => d.seats.find((s) => s.seat === name)!;
const test = (s: ReturnType<typeof seat>, key: string) => s.tests.find((t) => t.key === key)!;

describe("a position every seat is comfortable with", () => {
  const d = riskDebate(debateInput({ proposed: 3_000 }));

  it("is approved in full by all three, with every test well inside its bar", () => {
    for (const s of d.seats) {
      expect(s.stance).toBe("approve");
      expect(s.value).toBe(3_000);
      expect(s.binding).toBeNull();
      expect(s.tests.map((t) => t.status)).toEqual(["within", "within", "within", "within"]);
    }
    expect(d.stance).toBe("approve");
    expect(d.value).toBe(3_000);
    expect(d.measured).toBe(true);
    expect(d.window).toEqual({ asOf: "2026-10-20", sessions: N });
  });

  it("measures each test by hand", () => {
    const s = seat(d, "neutral");
    // 1-day 95% loss 4% of 3,000 = 120 = 0.12% of 100,000
    expect(test(s, "bad_day").value).toBeCloseTo(0.0012, 10);
    // beta 1 on 3,000 of 100,000 capital
    expect(test(s, "market").value).toBeCloseTo(0.03, 10);
    // nothing else held: just the position, 3%
    expect(test(s, "overlap").value).toBeCloseTo(0.03, 10);
    // 5,000,000 a day × 10% = 500,000 a session
    expect(test(s, "exit").value).toBeCloseTo(0.006, 10);
  });

  it("is deterministic and survives a JSON round trip", () => {
    expect(riskDebate(debateInput({ proposed: 3_000 }))).toEqual(d);
    expect(JSON.parse(JSON.stringify(d))).toEqual(d);
  });
});

describe("the loss on a bad day", () => {
  // 8,000 adds 4% × 8,000 = 320 = 0.32% of capital; the bars are 0.20% / 0.35% / 0.60%
  const d = riskDebate(debateInput());

  it("cuts the conservative seat to the position whose bad day fits its bar", () => {
    const s = seat(d, "conservative");
    // 0.002 × 100,000 / 0.04 = 5,000
    expect(s.stance).toBe("reduce");
    expect(s.value).toBeCloseTo(5_000, 4);
    expect(s.binding).toBe("bad_day");
    expect(test(s, "bad_day").status).toBe("over");
    expect(test(s, "bad_day").ceiling).toBeCloseTo(5_000, 4);
    expect(s.verdict).toContain("held down by the loss it adds on a bad day");
  });

  it("calls the neutral seat close to its bar but lets it through", () => {
    const s = seat(d, "neutral");
    expect(test(s, "bad_day").status).toBe("close");
    expect(s.stance).toBe("approve");
    expect(s.against.join(" ")).toContain("close to the bar");
    expect(s.for.join(" ")).toContain("rate TEST Buy");
  });

  it("leaves the aggressive seat well inside", () => {
    expect(test(seat(d, "aggressive"), "bad_day").status).toBe("within");
    expect(seat(d, "aggressive").stance).toBe("approve");
  });

  it("follows the seat that matches the person's risk tolerance", () => {
    const low = riskDebate(debateInput({ tolerance: "low" }));
    expect(low.deciding).toBe("conservative");
    expect(low.stance).toBe("reduce");
    expect(low.value).toBeCloseTo(5_000, 4);

    const medium = riskDebate(debateInput({ tolerance: "medium" }));
    expect(medium.deciding).toBe("neutral");
    expect(medium.stance).toBe("approve");
    expect(medium.because).toBe("Your medium risk tolerance follows the neutral seat.");

    const high = riskDebate(debateInput({ tolerance: "high" }));
    expect(high.deciding).toBe("aggressive");
  });

  it("uses the conservative seat, and says so, when no risk tolerance is set", () => {
    const unset = riskDebate(debateInput({ tolerance: null }));
    expect(unset.deciding).toBe("conservative");
    expect(unset.because).toContain("not set on your profile");
  });

  it("counts a holding that offsets the stock as taking loss off", () => {
    // BBB loses on different days from the stock. On BBB's six worst days (−4% on 40,000 = −1,600) the
    // stock gains 1%: 8,000 × 1% = 80, so the book's bad day falls from 1,600 to 1,520.
    const offset = riskDebate(debateInput({ book: measured({ others: [{ ticker: "BBB", value: 40_000, returns: dropOn(0.04, 8) }] }) }));
    const t = test(seat(offset, "neutral"), "bad_day");
    expect(t.value).toBeCloseTo(-0.0008, 10);
    expect(t.status).toBe("within");
    expect(t.note).toContain("takes 80 USD off");
    // and BBB is not counted as moving with the stock: their correlation is about −0.07
    expect(test(seat(offset, "neutral"), "overlap").note).toContain("None of your holdings moves with it");
  });
});

describe("overlap with what is already held", () => {
  // AAA moves exactly with the stock (correlation 1) and is 40,000 of 100,000
  const book = measured({ others: [{ ticker: "AAA", value: 40_000, returns: dropOn(0.04) }] });
  const d = riskDebate(debateInput({ book }));

  it("turns the conservative and neutral seats away: no room is left under their bars", () => {
    for (const name of ["conservative", "neutral"] as const) {
      const s = seat(d, name);
      expect(s.stance).toBe("reject");
      expect(s.value).toBe(0);
      expect(s.binding).toBe("overlap");
      expect(test(s, "overlap").ceiling).toBe(0);
    }
    // neutral: (8,000 + 40,000) / 100,000 = 48%, against a 35% bar
    expect(test(seat(d, "neutral"), "overlap").value).toBeCloseTo(0.48, 10);
    expect(test(seat(d, "neutral"), "overlap").note).toContain("AAA (1.00) moves with it");
  });

  it("lets the aggressive seat through at its 50% bar, and says it is close", () => {
    const s = seat(d, "aggressive");
    expect(s.stance).toBe("approve");
    expect(test(s, "overlap").ceiling).toBe(8_000);
    expect(test(s, "overlap").status).toBe("close");
  });

  it("states the deciding seat's objection as a sentence", () => {
    expect(d.stance).toBe("reject");
    expect(objection(d)).toContain("the neutral risk seat");
    expect(objection(d)).toContain("its overlap with what you hold");
    expect(objection(d)).toContain("AAA (1.00)");
  });
});

describe("market sensitivity", () => {
  // the stock has beta 3; B (beta 1.1, value 95,000) is built from the market plus noise that is
  // orthogonal to it, and so is not correlated enough with the stock to count as overlap
  const noise = Array.from({ length: N }, (_, t) => (t % 4 < 2 ? 0.05 : -0.05));
  const b = alternating.map((m, t) => 1.1 * m + noise[t]);
  const book = measured({ candidate: scaled(3, alternating), market: alternating, others: [{ ticker: "B", value: 95_000, returns: b }] });
  const d = riskDebate(debateInput({ book }));

  it("limits the conservative seat so the capital's beta stays at 1.15", () => {
    // others: 1.1 × 95,000 = 104,500; (1.15 × 100,000 − 104,500) / 3 = 3,500
    const s = seat(d, "conservative");
    expect(test(s, "market").ceiling).toBeCloseTo(3_500, 6);
    expect(s.stance).toBe("reduce");
    expect(s.value).toBeCloseTo(3_500, 6);
    expect(s.binding).toBe("market");
    // 1.045 before, (104,500 + 3 × 8,000) / 100,000 = 1.285 after
    expect(test(s, "market").value).toBeCloseTo(1.285, 8);
    // 1.045 sits on a rounding edge, so either neighbour is a correct two-decimal reading
    expect(test(s, "market").note).toMatch(/from 1\.0[45] to 1\.29/);
  });

  it("lets the neutral seat through at 1.285 against 1.30, as close, and the aggressive seat easily", () => {
    expect(test(seat(d, "neutral"), "market").status).toBe("close");
    expect(test(seat(d, "neutral"), "market").ceiling).toBeCloseTo(8_000, 6);
    expect(seat(d, "neutral").stance).toBe("approve");
    expect(test(seat(d, "aggressive"), "market").status).toBe("within");
  });

  it("does not hold a stock that moves against the market to the bar", () => {
    const hedge = riskDebate(debateInput({ book: measured({ candidate: scaled(-1, alternating), market: alternating }) }));
    const t = test(seat(hedge, "conservative"), "market");
    expect(t.status).toBe("within");
    expect(t.ceiling).toBe(8_000);
    expect(t.note).toContain("does not move with the market");
  });
});

describe("time to exit", () => {
  // 10,000 a day × 10% = 1,000 a session
  const thin = riskDebate(debateInput({ avgDollarVolume: 10_000 }));

  it("gives the three seats three different answers", () => {
    const c = seat(thin, "conservative");
    const n = seat(thin, "neutral");
    const a = seat(thin, "aggressive");
    // 1 session = 1,000, under a quarter of the 8,000 addition (2,000): turned away
    expect(c.stance).toBe("reject");
    expect(c.value).toBe(0);
    expect(test(c, "exit").ceiling).toBe(1_000);
    expect(test(c, "exit").value).toBeCloseTo(8, 10);
    // 3 sessions = 3,000, 5 sessions = 5,000
    expect(n.stance).toBe("reduce");
    expect(n.value).toBeCloseTo(3_000, 6);
    expect(a.stance).toBe("reduce");
    expect(a.value).toBeCloseTo(5_000, 6);
    expect(n.binding).toBe("exit");
  });

  it("never sells what is already held to meet a bar", () => {
    // 5,000 held; the conservative bar allows 1,000, which is below what is held
    const held = riskDebate(debateInput({ held: 5_000, avgDollarVolume: 10_000 }));
    const c = seat(held, "conservative");
    expect(c.stance).toBe("reject");
    expect(c.value).toBe(5_000);
  });

  it("converts the volume with the exchange rate", () => {
    // 10,000 a day in the listing currency × 0.5 = 5,000 a day in the base currency
    const fx = riskDebate(debateInput({ avgDollarVolume: 10_000, fxToBase: 0.5 }));
    expect(test(seat(fx, "conservative"), "exit").ceiling).toBe(500);
  });
});

describe("what the desk could not measure is never a free pass", () => {
  it("takes a share of the addition off for each unmeasured test, more for a more cautious seat", () => {
    // no S&P 500 series: one test unmeasured. 8,000 × 0.5 = 4,000 for the conservative seat, × 0.75 = 6,000 for the neutral one.
    const d = riskDebate(debateInput({ book: measured({ market: null }) }));
    const c = seat(d, "conservative");
    expect(test(c, "market").status).toBe("unmeasured");
    expect(test(c, "market").ceiling).toBeNull();
    expect(c.haircut).toBe(0.5);
    expect(c.stance).toBe("reduce");
    expect(c.value).toBeCloseTo(4_000, 6);
    expect(c.binding).toBe("unmeasured");
    expect(c.against.join(" ")).toContain("keeps 50% of the addition for it");

    expect(seat(d, "neutral").value).toBeCloseTo(6_000, 6);
    expect(seat(d, "aggressive").stance).toBe("approve");
    expect(seat(d, "aggressive").against.join(" ")).toContain("goes ahead regardless");
  });

  it("prices in a whole book that could not be built", () => {
    const reason = "fewer than 40 trading days are shared by TEST and everything you hold";
    const d = riskDebate(debateInput({ book: { status: "unmeasured", reason } }));
    expect(d.measured).toBe(false);
    expect(d.window).toBeNull();
    expect(d.warnings).toEqual([`The portfolio could not be measured: ${reason}.`]);
    // three tests unmeasured, the exit test measured: 0.5³ = 0.125 → 1,000 (under a quarter of 8,000: reject); 0.75³ = 0.421875 → 3,375
    expect(seat(d, "conservative").haircut).toBe(0.125);
    expect(seat(d, "conservative").stance).toBe("reject");
    expect(seat(d, "neutral").stance).toBe("reduce");
    expect(seat(d, "neutral").value).toBeCloseTo(3_375, 6);
    expect(seat(d, "aggressive").stance).toBe("approve");
  });

  it("treats missing volume as a gap too", () => {
    const d = riskDebate(debateInput({ avgDollarVolume: null }));
    expect(test(seat(d, "neutral"), "exit").status).toBe("unmeasured");
    expect(test(seat(d, "neutral"), "exit").note).toContain("no volume history");
    expect(seat(d, "neutral").value).toBeCloseTo(6_000, 6);
  });

  it("names holdings left out for want of prices", () => {
    const d = riskDebate(debateInput({ book: measured({ skipped: ["ZZZ"] }) }));
    expect(d.warnings).toEqual(["ZZZ has no price history, so it is left out of these figures."]);
  });
});

describe("the rules", () => {
  it("get stricter from the aggressive seat to the conservative one on every bar", () => {
    const { conservative: c, neutral: n, aggressive: a } = SEAT_RULES;
    expect(c.badDay).toBeLessThan(n.badDay);
    expect(n.badDay).toBeLessThan(a.badDay);
    expect(c.beta).toBeLessThan(n.beta);
    expect(n.beta).toBeLessThan(a.beta);
    expect(c.overlap).toBeLessThan(n.overlap);
    expect(n.overlap).toBeLessThan(a.overlap);
    expect(c.overlapCorrelation).toBeLessThan(n.overlapCorrelation);
    expect(n.overlapCorrelation).toBeLessThan(a.overlapCorrelation);
    expect(c.exitSessions).toBeLessThan(n.exitSessions);
    expect(n.exitSessions).toBeLessThan(a.exitSessions);
    expect(c.unmeasured).toBeLessThan(n.unmeasured);
    expect(n.unmeasured).toBeLessThan(a.unmeasured);
  });

  it("never let the aggressive seat wait longer to exit than the sizing's own liquidity ceiling", () => {
    expect(SEAT_RULES.aggressive.exitSessions).toBe(5);
    expect(DEBATE_RULES.participation).toBe(0.1);
  });
});

/* ------------------------------------------------- inside the decision */

// Medium tolerance, 100,000 of capital: a buy of 8,000 (80 shares at 100), a liquid stock.
const decisionInput = (book: RiskBook | null, over: Parameters<typeof baseInput>[0] = {}) =>
  baseInput({ avgDollarVolume: 5_000_000, book, ...over });

describe("the debate inside the decision", () => {
  it("is not run without a book", () => {
    const d = decide(decisionInput(null));
    expect(d.riskDebate).toBeNull();
    expect(d.sizing.shares).toBe(80);
  });

  it("is not run for a decision that is not a purchase", () => {
    const sell = baseInput({ rating: { ...baseInput().rating, dimensions: baseInput().rating.dimensions.map((x) => ({ ...x, resolved: -2 })) }, book: measured() });
    const d = decide(sell);
    expect(d.rating.final).toBe("sell");
    expect(d.riskDebate).toBeNull();
  });

  it("leaves the buy as it was when the deciding seat approves", () => {
    const d = decide(decisionInput(measured()));
    expect(d.riskDebate?.stance).toBe("approve");
    expect(d.riskDebate?.deciding).toBe("neutral");
    expect(d.action).toBe("buy");
    expect(d.sizing.shares).toBe(80);
    expect(d.sizing.finalCap).toBeNull();
  });

  it("cuts the size to the deciding seat's position and says so", () => {
    // 8% in a stock whose bad day is 8%: 8,000 × 8% = 640 = 0.64% of capital, against the neutral bar 0.35%
    // → 0.0035 × 100,000 / 0.08 = 4,375 → 43 shares at 100
    const d = decide(decisionInput(measured({ candidate: dropOn(0.08), market: dropOn(0.08) })));
    expect(d.riskDebate?.stance).toBe("reduce");
    expect(d.action).toBe("buy");
    expect(d.sizing.shares).toBe(43);
    expect(d.sizing.targetValue).toBeCloseTo(4_375, 4);
    expect(d.sizing.finalCap).toMatchObject({ name: "neutral risk seat" });
    expect(d.sizing.targetWeight).toBeCloseTo(0.04375, 6);
    expect(d.cautions.join(" ")).toContain("The neutral risk seat, which follows your risk tolerance, cut the position from 8,000 to 4,375 USD");
    expect(d.headline).toContain("buy 43 shares");
    expect(d.blockers).toEqual([]);
  });

  it("turns a purchase into an avoid, with the reason, when the deciding seat leaves no room", () => {
    // 40,000 held in AAA, which moves exactly with the stock; 60,000 set aside
    const book = measured({ others: [{ ticker: "AAA", value: 40_000, returns: dropOn(0.04) }] });
    const d = decide(
      decisionInput(book, {
        portfolio: { holdingsValue: 40_000, heldValue: 0, heldQty: 0, sectorValue: null },
        profile: { tolerance: "medium", plannedSize: null, investableAmount: 60_000, maxLossShare: null },
      })
    );
    expect(d.rating.final).toBe("buy");
    expect(d.riskDebate?.stance).toBe("reject");
    expect(d.action).toBe("avoid");
    expect(d.blockers).toHaveLength(1);
    expect(d.blockers[0]).toContain("the neutral risk seat");
    expect(d.blockers[0]).toContain("overlap");
    expect(d.plan.side).toBe("none");
    expect(d.sizing.shares).toBe(0);
    expect(d.headline).toContain("Buy, but not for you right now");
  });

  it("follows the person's own tolerance: the same book is a buy for someone who accepts more", () => {
    const book = measured({ others: [{ ticker: "AAA", value: 40_000, returns: dropOn(0.04) }] });
    const d = decide(
      decisionInput(book, {
        portfolio: { holdingsValue: 40_000, heldValue: 0, heldQty: 0, sectorValue: null },
        profile: { tolerance: "high", plannedSize: null, investableAmount: 60_000, maxLossShare: null },
      })
    );
    // the high-tolerance cap is 10% = 10,000 → 100 shares; the aggressive seat's 50% overlap bar allows exactly 10,000
    expect(d.riskDebate?.deciding).toBe("aggressive");
    expect(d.riskDebate?.stance).toBe("approve");
    expect(d.action).toBe("buy");
    expect(d.sizing.shares).toBe(100);
    // and the conservative and neutral seats are still shown as the range
    expect(d.riskDebate?.seats.map((s) => s.stance)).toEqual(["reject", "reject", "approve"]);
  });

  it("falls back to a hold when the cut leaves less than a share to add", () => {
    // 79 shares held (7,900); the plan asks for 8,000 → one more share. Volume allows the neutral seat 3 sessions
    // × 2,650 = 7,950: 50 more is half a share
    const d = decide(
      decisionInput(measured(), {
        avgDollarVolume: 26_500,
        portfolio: { holdingsValue: 7_900, heldValue: 7_900, heldQty: 79, sectorValue: null },
        profile: { tolerance: "medium", plannedSize: null, investableAmount: 92_100, maxLossShare: null },
      })
    );
    expect(d.riskDebate?.stance).toBe("reduce");
    expect(d.riskDebate?.value).toBeCloseTo(7_950, 6);
    expect(d.sizing.shares).toBe(0);
    expect(d.action).toBe("hold");
    expect(d.cautions.join(" ")).toContain("no larger than what you hold, or under one share");
  });

  it("records the debate in the decision, so a recorded decision shows the arguments it was made on", () => {
    const d = decide(decisionInput(measured()));
    const copy = JSON.parse(JSON.stringify(d));
    expect(copy.riskDebate.seats).toHaveLength(3);
    expect(copy.riskDebate.seats[0].tests).toHaveLength(4);
  });
});
