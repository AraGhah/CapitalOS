import { describe, expect, it } from "vitest";
import { ConfigError, parseConfig } from "../../lib/config";

describe("SIGNAL_FEEDS", () => {
  it("reads Polymarket by default and leaves StockTwits to be opted into", () => {
    expect(parseConfig({}).SIGNAL_FEEDS).toEqual(["polymarket"]);
  });

  it("takes a list", () => {
    expect(parseConfig({ SIGNAL_FEEDS: "stocktwits, polymarket" }).SIGNAL_FEEDS).toEqual(["stocktwits", "polymarket"]);
  });

  it('is switched off with "none", since an empty value counts as unset', () => {
    expect(parseConfig({ SIGNAL_FEEDS: "none" }).SIGNAL_FEEDS).toEqual([]);
    expect(parseConfig({ SIGNAL_FEEDS: "" }).SIGNAL_FEEDS).toEqual(["polymarket"]);
  });

  it("refuses a feed it does not know instead of quietly ignoring it", () => {
    expect(() => parseConfig({ SIGNAL_FEEDS: "twitter" })).toThrow(ConfigError);
  });

  it("keeps readings for six hours unless told otherwise, and bounds the TTL", () => {
    expect(parseConfig({}).SIGNAL_TTL_MINUTES).toBe(360);
    expect(() => parseConfig({ SIGNAL_TTL_MINUTES: "0" })).toThrow(ConfigError);
    expect(() => parseConfig({ SIGNAL_TTL_MINUTES: "99999" })).toThrow(ConfigError);
  });
});
