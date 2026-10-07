import { describe, expect, it } from "vitest";
import { capToolResult, guardToolCall, MAX_TOOL_RESULT_CHARS, tickerNamedBy } from "../../lib/ai/guards";

describe("copilot tool guards (AI-01)", () => {
  it("lets a side-effecting tool run for a ticker the person named", () => {
    expect(guardToolCall("research_ticker", { ticker: "NVDA" }, "what do you think of NVDA?").allowed).toBe(true);
    expect(guardToolCall("research_ticker", { ticker: "nvda" }, "research $nvda please").allowed).toBe(true);
    expect(guardToolCall("convene_committee", { ticker: "MSFT" }, "convene a committee on msft").allowed).toBe(true);
  });

  it("allows the company's name in place of its symbol", () => {
    expect(guardToolCall("research_ticker", { ticker: "NVDA" }, "research Nvidia", "NVIDIA CORP").allowed).toBe(true);
  });

  it("refuses a ticker that only a tool result mentioned (prompt injection)", () => {
    const r = guardToolCall("convene_committee", { ticker: "GME" }, "summarise today's news about Apple", "GameStop Corp");
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/third party/);
  });

  it("does not read ordinary words as tickers", () => {
    expect(tickerNamedBy("is it all over now?", "IT")).toBe(false);
    expect(tickerNamedBy("is it all over now?", "ALL")).toBe(false);
    expect(tickerNamedBy("what about IT and ALL", "IT")).toBe(true);
    expect(tickerNamedBy("thoughts on $now", "NOW")).toBe(true);
  });

  it("does not guard read-only tools", () => {
    expect(guardToolCall("get_news", { query: "anything" }, "hi").allowed).toBe(true);
    expect(guardToolCall("get_quote", { ticker: "XYZ" }, "hi").allowed).toBe(true);
  });

  it("caps an oversized tool result and says so", () => {
    const huge = { rows: "x".repeat(MAX_TOOL_RESULT_CHARS * 2) };
    const capped = JSON.parse(capToolResult(huge));
    expect(capped.truncated).toBe(true);
    expect(capped.partial.length).toBe(MAX_TOOL_RESULT_CHARS);
    expect(capToolResult({ ok: 1 })).toBe('{"ok":1}');
  });
});
