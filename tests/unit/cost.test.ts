import { describe, expect, it } from "vitest";
import { costOf, type ModelSpec } from "../../lib/ai/models";

const spec = (prices: Partial<ModelSpec>): ModelSpec => ({
  id: "m",
  provider: "anthropic",
  providerConfig: { kind: "anthropic", keyEnv: "ANTHROPIC_API_KEY" },
  model: "m",
  label: "M",
  tier: "standard",
  priceIn: null,
  priceOut: null,
  priceCacheRead: null,
  priceCacheWrite: null,
  ...prices,
});

describe("model cost (COST-01)", () => {
  it("prices input, output, cache reads and cache writes at their own rates", () => {
    const c = costOf(spec({ priceIn: 2, priceOut: 10, priceCacheRead: 0.2, priceCacheWrite: 2.5 }), {
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      cachedTokens: 2_000_000,
      cacheWriteTokens: 400_000,
    });
    expect(c.usd).toBeCloseTo(2 + 1 + 0.4 + 1, 10);
    expect(c.estimated).toBe(false);
  });

  it("prices cache tokens as plain input when no cache rate is listed", () => {
    const c = costOf(spec({ priceIn: 1, priceOut: 5 }), { inputTokens: 0, outputTokens: 0, cachedTokens: 1_000_000, cacheWriteTokens: 0 });
    expect(c.usd).toBeCloseTo(1, 10);
  });

  it("never treats an unpriced model as free", () => {
    const c = costOf(spec({}), { inputTokens: 500_000, outputTokens: 500_000, cachedTokens: 0, cacheWriteTokens: 0 });
    expect(c.usd).toBeGreaterThan(0);
    expect(c.estimated).toBe(true);
  });
});
