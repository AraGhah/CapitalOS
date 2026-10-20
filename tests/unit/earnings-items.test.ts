import { describe, expect, it } from "vitest";
import { earningsItems } from "../../lib/ai/earnings-items";
import { checkClaim } from "../../lib/ai/factcheck";
import { renderEvidence, type EvidenceItem, type EvidencePack } from "../../lib/ai/evidence";
import { DRIFT_RULES } from "../../lib/earnings/drift";
import { measuredRead } from "./earnings-fixtures";

const source = { kind: "computed", ref: "computed from test filings by lib/earnings" };
const build = (read = measuredRead()): EvidenceItem[] => earningsItems(read, source).map((item, i) => ({ id: `E${i + 1}`, ...item }));
const items = build();

const find = (label: RegExp, list = items) => {
  const item = list.find((i) => label.test(i.label));
  if (!item) throw new Error(`no item for ${label}`);
  return item;
};

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

const claim = (text: string, evidence: string[]) => ({ key: "c", text, evidence, agent: "a", modelId: "m", stage: "analysis" });

describe("earnings evidence items", () => {
  it("are all earnings items, sourced to the computation", () => {
    expect(items.length).toBeGreaterThan(8);
    expect(items.every((i) => i.kind === "earnings" && i.source.kind === "computed")).toBe(true);
  });

  it("carry the quarter's EPS, the year-ago EPS, the change and the standardised surprise", () => {
    expect(find(/latest quarter/).value).toBeCloseTo(1.16, 6);
    expect(find(/same quarter a year earlier$/).value).toBe(1);
    expect(find(/^Change in diluted/).value).toBeCloseTo(0.16, 6);
    expect(find(/SUE/).value).toBeCloseTo(2.598, 3);
    expect(find(/SUE/).unit).toBe("index");
    expect(find(/latest quarter/).asOf).toBe("2026-03-31");
  });

  it("carry the reaction, the market's move, the abnormal return and the drift since", () => {
    // stock 100 → 105 around the announcement, market 400 → 404
    expect(find(/^Stock return around/).value).toBeCloseTo(0.05, 6);
    expect(find(/^Market \(S&P 500\) return/).value).toBeCloseTo(0.01, 6);
    expect(find(/^Abnormal return around/).value).toBeCloseTo(0.04, 6);
    expect(find(/^Abnormal return since/).value).toBeCloseTo(107 / 105 - 406 / 404, 6);
    expect(find(/^Sessions since the earnings reaction/).value).toBe(2);
    expect(find(/^Sessions in the window/).value).toBe(DRIFT_RULES.window);
  });

  it("date the announcement and say what dated it", () => {
    expect(find(/announcement date/).text).toContain("2026-04-28");
    expect(find(/announcement date/).text).toContain("8-K");
    const late = build(measuredRead({ releases: [] }));
    expect(find(/announcement date/, late).text).toContain("periodic filing");
  });

  it("state the readings in words, without a number a model could misquote, and make no forecast", () => {
    const readings = items.filter((i) => i.value === undefined && /reading$/.test(i.label));
    expect(readings).toHaveLength(2);
    for (const reading of readings) {
      expect(reading.text).not.toMatch(/\d/);
      expect(reading.text).not.toMatch(/will |expect|target|upside/i);
    }
    expect(find(/surprise reading/).text).toMatch(/^beat/);
    expect(find(/reaction reading/).text).toMatch(/^confirmed/);
    expect(find(/reaction reading/).text).toContain("not a forecast");
  });

  it("keep the surprise and drop the reaction when there are no prices", () => {
    const list = build(measuredRead({ stock: [], market: null }));
    expect(list.some((i) => /SUE/.test(i.label))).toBe(true);
    expect(list.some((i) => /reaction|Abnormal|Stock return/.test(i.label))).toBe(false);
  });

  it("leave out the market's move, and the word abnormal, when no market series covers the dates", () => {
    const list = build(measuredRead({ market: null }));
    expect(list.some((i) => /^Market \(S&P 500\)/.test(i.label))).toBe(false);
    expect(list.some((i) => /abnormal/i.test(i.label))).toBe(false);
    expect(find(/^Stock return around/, list).value).toBeCloseTo(0.05, 6);
    expect(find(/not adjusted for the market/, list).value).toBeCloseTo(107 / 105 - 1, 6);
  });

  it("are empty when no quarter can be read", () => {
    expect(earningsItems(measuredRead({ quarters: [] }), source)).toEqual([]);
  });

  it("print in the pack as the figures a model would restate", () => {
    const text = renderEvidence(packOf(items));
    expect(text).toMatch(/Standardised unexpected earnings \(SUE\)[^\n]* = 2\.6 · /);
    expect(text).toMatch(/Abnormal return around the earnings announcement[^\n]* = 4\.00% · /);
  });
});

describe("the fact checker on earnings figures", () => {
  const pack = packOf(items);
  const sue = find(/SUE/);
  const abnormal = find(/^Abnormal return around/);
  const eps = find(/latest quarter/);

  it("verifies a surprise the model restated from the item and refuses one the pack never held", () => {
    expect(checkClaim(claim("the surprise was 2.6 standard deviations", [sue.id]), pack).verdict).toBe("verified");
    expect(checkClaim(claim("the surprise was 4.1 standard deviations", [sue.id]), pack).verdict).toBe("unsupported");
  });

  it("verifies the abnormal return and catches the opposite direction", () => {
    expect(checkClaim(claim("the stock's abnormal return rose 4.0% around the announcement", [abnormal.id]), pack).verdict).toBe("verified");
    expect(checkClaim(claim("the stock's abnormal return fell 4.0% around the announcement", [abnormal.id]), pack).verdict).not.toBe("verified");
  });

  it("verifies EPS as a dollar figure", () => {
    expect(checkClaim(claim(`diluted EPS was $${eps.value!.toFixed(2)}`, [eps.id]), pack).verdict).toBe("verified");
  });
});
