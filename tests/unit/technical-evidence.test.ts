import { describe, expect, it } from "vitest";
import { checkClaim, extractFigures } from "../../lib/ai/factcheck";
import { formatValue, renderEvidence, type EvidenceItem, type EvidencePack } from "../../lib/ai/evidence";
import { technicalItems } from "../../lib/ai/technical-items";
import { technicalSnapshot, type OhlcvBar } from "../../lib/technicals";

// 260 sessions of a market that drifts up with a wobble, so every indicator has a value.
const bars: OhlcvBar[] = Array.from({ length: 260 }, (_, i) => {
  const close = Number((100 + i * 0.4 + Math.sin(i / 5) * 3).toFixed(2));
  return {
    date: new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10),
    open: close - 0.2,
    high: close + 1.1,
    low: close - 1.3,
    close,
    volume: 2_000_000 + (i % 7) * 100_000,
  };
});

const source = { kind: "computed", ref: "computed from test bars by lib/technicals" };
const snapshot = technicalSnapshot(bars)!;
const items: EvidenceItem[] = technicalItems(snapshot, source).map((item, i) => ({ id: `E${i + 1}`, ...item }));

function packOf(list: EvidenceItem[]): EvidencePack {
  return {
    ticker: "TEST",
    name: "Test Co",
    sector: null,
    industry: null,
    generatedAt: "2026-10-20T00:00:00.000Z",
    periodEnd: null,
    items: list,
    coverage: { inputs: [], present: 0, expected: 0 },
    hash: "x",
  };
}

const find = (label: RegExp) => {
  const item = items.find((i) => label.test(i.label));
  if (!item) throw new Error(`no item for ${label}`);
  return item;
};

describe("technical evidence items", () => {
  it("are all technical, dated to the last session and sourced to the computation", () => {
    expect(items.length).toBeGreaterThan(15);
    expect(items.every((i) => i.kind === "technical" && i.asOf === snapshot.asOf && i.source.kind === "computed")).toBe(true);
  });

  it("carry the value of every indicator the snapshot has", () => {
    expect(find(/RSI\(14\)/).value).toBe(snapshot.rsi14);
    expect(find(/200-day simple/).value).toBe(snapshot.sma200);
    expect(find(/MACD line/).value).toBe(snapshot.macd!.line);
    expect(find(/Bollinger upper/).value).toBe(snapshot.bollinger!.upper);
    expect(find(/Average true range/).value).toBe(snapshot.atr14);
  });

  it("leave out an indicator the history is too short for", () => {
    const short = technicalSnapshot(bars.slice(0, 40))!;
    const labels = technicalItems(short, source).map((i) => i.label);
    expect(labels.some((l) => /200-day simple/.test(l))).toBe(false);
    expect(labels.some((l) => /RSI\(14\)/.test(l))).toBe(true);
  });

  it("state the readings in words, without a number a model could misquote", () => {
    const readings = items.filter((i) => i.value === undefined);
    expect(readings.length).toBeGreaterThan(3);
    // the only digits allowed are the kind the checker ignores: "50-day", "9 sessions ago"
    for (const reading of readings) expect(reading.text!.replace(/\d+-day|\d+ sessions/g, "")).not.toMatch(/\d/);
  });

  it("print the RSI to one decimal", () => {
    expect(formatValue(58.3412, "index")).toBe("58.3");
    expect(renderEvidence(packOf(items))).toMatch(/\[E\d+\] Relative strength index, RSI\(14\), \d{4}-\d{2}-\d{2} = \d+\.\d · /);
  });
});

describe("the fact checker on technical figures", () => {
  const pack = packOf(items);
  const rsi = find(/RSI\(14\)/);
  const sma200 = find(/200-day simple/);
  const vs200 = find(/versus the 200-day/);

  it("does not read the setting of an indicator as a figure", () => {
    const figures = extractFigures("RSI(14) is 58.3, MACD(12,26,9) is positive and Bollinger Bands (20, 2) are wide on a 14-period view").map((f) => f.raw);
    expect(figures).toEqual(["58.3"]);
  });

  it("verifies an RSI the model restated from the item", () => {
    const claim = { key: "c1", text: `RSI(14) stands at ${rsi.value!.toFixed(1)}`, evidence: [rsi.id], agent: "a", modelId: "m", stage: "analysis" };
    expect(checkClaim(claim, pack).verdict).toBe("verified");
  });

  it("refuses an RSI the pack never contained", () => {
    const claim = { key: "c2", text: `RSI(14) stands at ${(rsi.value! + 9).toFixed(1)}`, evidence: [rsi.id], agent: "a", modelId: "m", stage: "analysis" };
    expect(checkClaim(claim, pack).verdict).toBe("unsupported");
  });

  it("verifies a dollar level and refuses a bare number as a dollar level", () => {
    const level = sma200.value!;
    const dollars = { key: "c3", text: `the 200-day SMA is $${level.toFixed(2)}`, evidence: [sma200.id], agent: "a", modelId: "m", stage: "analysis" };
    expect(checkClaim(dollars, pack).verdict).toBe("verified");
    const bare = { key: "c4", text: `the 200-day SMA is ${level.toFixed(2)}`, evidence: [sma200.id], agent: "a", modelId: "m", stage: "analysis" };
    expect(checkClaim(bare, pack).verdict).not.toBe("verified");
  });

  it("verifies the distance from an average and catches a claim about the wrong direction", () => {
    const pct = (Math.abs(vs200.value!) * 100).toFixed(1);
    const right = { key: "c5", text: `the last close is ${pct}% above the 200-day SMA`, evidence: [vs200.id], agent: "a", modelId: "m", stage: "analysis" };
    expect(checkClaim(right, pack).verdict).toBe("verified");
    // the market is above its average (a positive ratio), so "fell ... %" about this item is the opposite claim
    expect(vs200.value!).toBeGreaterThan(0);
    const wrong = { key: "c6", text: `the price fell ${pct}% versus the 200-day SMA`, evidence: [vs200.id], agent: "a", modelId: "m", stage: "analysis" };
    expect(checkClaim(wrong, pack).verdict).not.toBe("verified");
  });
});
