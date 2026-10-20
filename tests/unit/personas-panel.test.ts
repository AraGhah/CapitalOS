import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { LensRead } from "../../lib/personas/data";
import { LENSES, readLenses } from "../../lib/personas/lenses";
import { compounder, struggler } from "./lens-fixtures";

const read = vi.hoisted(() => ({ current: null as LensRead | Error | null }));

// The panel's data layer is not what is under test.
vi.mock("@/lib/personas/data", () => ({
  lensRead: async () => {
    if (read.current instanceof Error) throw read.current;
    return read.current;
  },
}));

const { LensesPanel, LensesView } = await import("../../app/components/PersonasPanel");

const view = (input = compounder()) => renderToStaticMarkup(LensesView({ report: readLenses(input) }));
const company = { id: "c1", ticker: "TEST", name: "Test Co", sector: "Technology" };

describe("LensesView", () => {
  it("lists every lens with its name, school and fit", () => {
    const html = view();
    expect(html).toContain("Investor lenses");
    for (const lens of LENSES) {
      expect(html).toContain(lens.name);
      expect(html).toContain(lens.school);
    }
    expect(html.match(/<details class="lens"/g)).toHaveLength(LENSES.length);
    expect(html).toContain('class="pill good">Fits</span>');
  });

  it("tallies the fits at the top", () => {
    expect(view()).toContain('class="pill good">7 fits</span>');
    expect(view()).toContain('class="pill info">1 mixed</span>');
  });

  it("shows a company that fails the tests as not fitting", () => {
    const html = view(struggler());
    expect(html).toContain("Does not fit");
    expect(html).toContain('class="pill bad"');
  });

  it("prints each check with its bar, the figure measured and how it came out", () => {
    const html = view();
    expect(html).toContain("The bar");
    expect(html).toContain("Measured");
    expect(html).toContain('class="pill good">Pass</span>');
    expect(html).toContain('class="pill bad">Fail</span>');
  });

  it("marks a check the desk has no data for, without a made-up figure", () => {
    const html = view(compounder({ sector: "Financials" }));
    expect(html).toContain('class="pill ">No data</span>');
    expect(html).toContain('class="num">—</td>');
  });

  it("lists what each investor weighed that no figure here answers", () => {
    const html = view();
    expect(html).toContain("Not measured");
    for (const lens of LENSES) for (const item of lens.notMeasured) expect(html).toContain(item.replace(/&/g, "&amp;").replace(/'/g, "&#x27;"));
  });

  it("shows the report's warnings", () => {
    const report = { ...readLenses(compounder()), warnings: ["Only 2 years of filings are on file."] };
    expect(renderToStaticMarkup(LensesView({ report }))).toContain("Only 2 years of filings are on file.");
  });

  it("says a lens is a way of looking and not a recommendation, and that no model is called", () => {
    const html = view();
    expect(html).toContain("A lens is a way of looking, not");
    expect(html).toContain("a recommendation");
    expect(html).toContain("with no model");
    expect(html).toContain("70%");
    expect(html).toContain("30%");
  });
});

describe("LensesPanel", () => {
  it("renders the report the data layer returns", async () => {
    read.current = { ...readLenses(compounder()), source: "prices_daily table" };
    const html = renderToStaticMarkup(await LensesPanel({ company }));
    expect(html).toContain("Investor lenses");
    expect(html).toContain("Graham");
  });

  it("reports a failure instead of breaking the page", async () => {
    read.current = new Error("database down");
    expect(renderToStaticMarkup(await LensesPanel({ company }))).toContain("could not be run: database down");
  });
});
