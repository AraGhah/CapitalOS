import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { TechnicalRead } from "../../lib/technical-read";
import { technicalSnapshot, THRESHOLDS, type OhlcvBar } from "../../lib/technicals";

const bars: OhlcvBar[] = Array.from({ length: 260 }, (_, i) => {
  const close = 50 + i * 0.5;
  return { date: new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10), open: close, high: close + 1, low: close - 1, close, volume: 1_000_000 };
});

const read = vi.hoisted(() => ({ current: null as TechnicalRead | Error | null }));

vi.mock("@/lib/technical-read", () => ({
  technicalRead: async () => {
    if (read.current instanceof Error) throw read.current;
    return read.current;
  },
}));

const { TechnicalPanel } = await import("../../app/components/TechnicalPanel");

const render = async () => renderToStaticMarkup(await TechnicalPanel({ ticker: "AAPL" }));

describe("TechnicalPanel", () => {
  it("shows the indicators, the readings and where the bars came from", async () => {
    read.current = { ticker: "AAPL", snapshot: technicalSnapshot(bars), source: "prices_daily", ref: "prices_daily table", thresholds: THRESHOLDS };
    const html = await render();
    expect(html).toContain("Technicals");
    expect(html).toContain("RSI(14)");
    expect(html).toContain("uptrend");
    expect(html).toContain("MACD(12,26,9)");
    expect(html).toContain("prices_daily table");
    expect(html).toContain("not predictions");
  });

  it("says so when there is not enough history", async () => {
    read.current = { ticker: "NEW", snapshot: null, source: "prices_daily", ref: "prices_daily table", thresholds: THRESHOLDS };
    expect(await render()).toContain("Not enough price history");
  });

  it("reports a failure instead of breaking the page", async () => {
    read.current = new Error("provider down");
    expect(await render()).toContain("could not be computed: provider down");
  });
});
