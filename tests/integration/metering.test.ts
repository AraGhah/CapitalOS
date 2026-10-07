import { afterEach, describe, expect, it } from "vitest";
import { resetConfig } from "../../lib/config";
import { assertWithinSpend, recordModelCall, SpendLimitError, spentToday } from "../../lib/ai/metering";
import { signedInUser } from "./helpers";

afterEach(() => {
  delete process.env.DAILY_SPEND_USD_LIMIT;
  resetConfig();
});

describe("daily spend limit (COST-01)", () => {
  it("adds up every call a person made today, whatever it was for", async () => {
    const u = await signedInUser();
    const base = { userId: u.userId, stage: "s", agent: "a", modelId: "m", provider: "anthropic", model: "m" };
    await recordModelCall({ ...base, purpose: "copilot", costUsd: 0.5 });
    await recordModelCall({ ...base, purpose: "strategist", costUsd: 0.25 });
    await recordModelCall({ ...base, purpose: "committee", costUsd: 1 });
    expect(await spentToday(u.userId)).toBeCloseTo(1.75, 6);
  });

  it("refuses the next call once the limit is reached, for that person only", async () => {
    process.env.DAILY_SPEND_USD_LIMIT = "1";
    resetConfig();
    const spender = await signedInUser();
    const other = await signedInUser();
    await recordModelCall({ userId: spender.userId, purpose: "copilot", stage: "s", agent: "a", modelId: "m", provider: "anthropic", model: "m", costUsd: 1.01 });
    await expect(assertWithinSpend(spender.userId)).rejects.toBeInstanceOf(SpendLimitError);
    await expect(assertWithinSpend(other.userId)).resolves.toBeUndefined();
  });
});
