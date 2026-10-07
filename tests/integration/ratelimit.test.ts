import { describe, expect, it } from "vitest";
import { limitUser, Semaphore, take, tryTake } from "../../lib/ratelimit";

describe("shared rate limits (ARC-02)", () => {
  it("never hands out more tokens than the bucket holds, however many race for them", async () => {
    const bucket = { key: "test:race", capacity: 5, perSecond: 0.001 };
    const results = await Promise.all(Array.from({ length: 25 }, () => tryTake(bucket)));
    expect(results.filter((w) => w === 0)).toHaveLength(5);
    expect(Math.min(...results.filter((w) => w > 0))).toBeGreaterThan(100);
  });

  it("refills over time and waits for a token", async () => {
    const bucket = { key: "test:refill", capacity: 1, perSecond: 10 };
    expect(await tryTake(bucket)).toBe(0);
    const started = Date.now();
    await take(bucket, 5_000);
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
  });

  it("refuses a user's burst with 429 instead of waiting", async () => {
    for (let i = 0; i < 3; i++) await limitUser("00000000-0000-0000-0000-000000000099", "test", 3);
    await expect(limitUser("00000000-0000-0000-0000-000000000099", "test", 3)).rejects.toMatchObject({ status: 429 });
  });

  it("caps concurrency inside one process", async () => {
    const sem = new Semaphore(2);
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 8 }, () =>
        sem.run(async () => {
          peak = Math.max(peak, ++active);
          await new Promise((r) => setTimeout(r, 10));
          active--;
        })
      )
    );
    expect(peak).toBe(2);
  });
});
