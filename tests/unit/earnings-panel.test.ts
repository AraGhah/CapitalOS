import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { EarningsRead } from "../../lib/earnings/data";
import { filings, measuredRead } from "./earnings-fixtures";

const read = vi.hoisted(() => ({ current: null as EarningsRead | Error | null }));

// The panel's data layer is not what is under test.
vi.mock("@/lib/earnings/data", () => ({
  earningsRead: async () => {
    if (read.current instanceof Error) throw read.current;
    return read.current;
  },
}));

const { EarningsDriftPanel, EarningsDriftView } = await import("../../app/components/EarningsDriftPanel");

const view = (drift = measuredRead(), source: string | null = "prices_daily table") => renderToStaticMarkup(EarningsDriftView({ drift, source }));

describe("EarningsDriftView", () => {
  it("shows the surprise, the stock's reaction and whether the market agreed", () => {
    const html = view();
    expect(html).toContain("Earnings drift");
    expect(html).toContain("quarter ended 2026-03-31");
    expect(html).toContain('class="pill good">beat</span>');
    expect(html).toContain("stock up");
    expect(html).toContain("market confirmed it");
    expect(html).toContain("1.16");
    expect(html).toContain("1.00 a year earlier");
    expect(html).toContain("+2.6");
  });

  it("dates the announcement and says where the date came from", () => {
    expect(view()).toContain("from the 8-K, Item 2.02");
    expect(view(measuredRead({ releases: [] }))).toContain("from the periodic filing, which can be weeks late");
  });

  it("shows the reaction against the market, the drift since and where that sits in the window", () => {
    const html = view();
    expect(html).toContain("+4.0%");
    expect(html).toContain("stock +5.0% against market +1.0%");
    expect(html).toContain("2 sessions of the 60-session window");
  });

  it("lists the last quarters newest first", () => {
    const html = view();
    expect(html.indexOf("2026-03-31</td>")).toBeGreaterThan(-1);
    expect(html.indexOf("2026-03-31</td>")).toBeLessThan(html.indexOf("2025-12-31</td>"));
  });

  it("says the history is too short instead of scoring a surprise", () => {
    // three quarters leave two earlier changes to judge the third by, and the prices begin after its announcement
    const sparse = view(measuredRead({ quarters: filings().slice(0, 3) }));
    expect(sparse).toContain("needs 4 earlier quarters, has 2");
    expect(sparse).toContain("unscaled");
    expect(sparse).toContain("reaction not measured");
    expect(sparse).not.toContain("beat");
  });

  it("says why the reaction is missing, and that a newer report cannot be read", () => {
    const html = view({ ...measuredRead({ stock: [], market: null }), newerReport: "A 10-K was filed on 2026-09-15 whose fourth quarter the desk cannot read." });
    expect(html).toContain("no price history");
    expect(html).toContain("A 10-K was filed on 2026-09-15");
  });

  it("says when the move was not adjusted for the market", () => {
    expect(view(measuredRead({ market: null }))).toContain("not adjusted for the market");
  });

  it("explains an unmeasured read instead of showing empty figures", () => {
    const html = view(measuredRead({ quarters: [] }));
    expect(html).toContain("Earnings drift");
    expect(html).toContain("npm run ingest-edgar");
    expect(html).not.toContain("Diluted EPS");
  });

  it("frames the effect as historical and not a forecast, and names its sources", () => {
    const html = view();
    expect(html).toContain("not a forecast");
    expect(html).toContain("no analyst estimates and no model");
    expect(html).toContain("prices_daily table");
  });
});

describe("EarningsDriftPanel", () => {
  it("renders the read the data layer returns", async () => {
    read.current = { ticker: "TEST", drift: measuredRead(), ref: "yahoo daily closes, 1y" };
    const html = renderToStaticMarkup(await EarningsDriftPanel({ company: { id: "c1", ticker: "TEST" } }));
    expect(html).toContain("market confirmed it");
    expect(html).toContain("yahoo daily closes, 1y");
  });

  it("reports a failure instead of breaking the page", async () => {
    read.current = new Error("database down");
    expect(renderToStaticMarkup(await EarningsDriftPanel({ company: { id: "c1", ticker: "TEST" } }))).toContain("could not be read: database down");
  });
});
