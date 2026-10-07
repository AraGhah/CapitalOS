import { describe, expect, it } from "vitest";
import { LockTimeoutError, pool, tryWithSessionLock, withLock } from "../../lib/db";

describe("advisory locks (DB-03)", () => {
  it("does not deadlock when more callers wait than the pool has connections", async () => {
    const max = (pool as unknown as { options: { max: number } }).options.max;
    let inside = 0;
    let peak = 0;
    const runs = Array.from({ length: max + 5 }, () =>
      withLock("test:many", async (client) => {
        inside++;
        peak = Math.max(peak, inside);
        await client.query("SELECT pg_sleep(0.01)");
        inside--;
        return true;
      })
    );
    expect(await Promise.all(runs)).toHaveLength(max + 5);
    expect(peak).toBe(1);
  });

  it("times out instead of waiting forever", async () => {
    let release!: () => void;
    const held = withLock("test:timeout", () => new Promise<void>((r) => (release = r)));
    await new Promise((r) => setTimeout(r, 50));
    await expect(withLock("test:timeout", async () => 1, { timeoutMs: 200 })).rejects.toBeInstanceOf(LockTimeoutError);
    release();
    await held;
  });

  it("releases the lock when the critical section throws", async () => {
    await expect(withLock("test:throw", async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await withLock("test:throw", async () => "ok", { timeoutMs: 500 })).toBe("ok");
  });

  it("lets only one session-lock holder in at a time", async () => {
    let release!: () => void;
    const first = tryWithSessionLock("test:session", () => new Promise<string>((r) => (release = () => r("first"))));
    await new Promise((r) => setTimeout(r, 50));
    expect(await tryWithSessionLock("test:session", async () => "second")).toBeNull();
    release();
    expect(await first).toBe("first");
    expect(await tryWithSessionLock("test:session", async () => "third")).toBe("third");
  });
});
