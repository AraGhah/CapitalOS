import { describe, expect, it } from "vitest";
import { pool } from "../../lib/db";
import {
  backoffSeconds,
  claim,
  claimScheduleSlot,
  enqueue,
  eventsAfter,
  fail,
  getJobById,
  reapExpired,
  succeed,
} from "../../lib/jobs/queue";
import { processJob, scheduleTick } from "../../lib/jobs/worker";
import { GET as events } from "../../app/api/jobs/[id]/events/route";
import { GET as getJobRoute } from "../../app/api/jobs/[id]/route";
import { call, signedInUser } from "./helpers";

describe("job queue (ARC-01)", () => {
  it("gives each job to exactly one of many concurrent claimers", async () => {
    for (let i = 0; i < 5; i++) await enqueue({ kind: "maintenance.retention", userId: null });
    const claimed = await Promise.all(Array.from({ length: 12 }, (_, i) => claim(`w${i}`, ["maintenance.retention"], 60_000)));
    const ids = claimed.filter(Boolean).map((j) => j!.id);
    expect(ids).toHaveLength(5);
    expect(new Set(ids).size).toBe(5);
  });

  it("does not queue the same logical job twice while one is pending", async () => {
    const a = await enqueue({ kind: "research", userId: null, payload: { ticker: "X" }, dedupeKey: "k1" });
    const b = await enqueue({ kind: "research", userId: null, payload: { ticker: "X" }, dedupeKey: "k1" });
    expect(b.existing).toBe(true);
    expect(b.job.id).toBe(a.job.id);

    const job = await claim("w", ["research"], 60_000);
    await succeed(job!.id, "w", null);
    const c = await enqueue({ kind: "research", userId: null, payload: { ticker: "X" }, dedupeKey: "k1" });
    expect(c.existing).toBe(false);
  });

  it("retries a retryable failure later, and dead-letters it when attempts run out", async () => {
    const { job } = await enqueue({ kind: "maintenance.retention", userId: null, maxAttempts: 2 });
    const first = await claim("w", ["maintenance.retention"], 60_000);
    expect(await fail(first!.id, "w", "boom", { retryable: true })).toBe("queued");
    const queued = await getJobById(job.id);
    expect(new Date(queued!.runAt).getTime()).toBeGreaterThan(Date.now() + 10_000);

    // not claimable until its backoff passes
    expect(await claim("w", ["maintenance.retention"], 60_000)).toBeNull();
    await pool.query(`UPDATE jobs SET run_at = now() WHERE id = $1`, [job.id]);
    const second = await claim("w", ["maintenance.retention"], 60_000);
    expect(second!.attempts).toBe(2);
    expect(await fail(second!.id, "w", "boom again", { retryable: true })).toBe("dead");
  });

  it("never retries a refusal", async () => {
    await enqueue({ kind: "maintenance.retention", userId: null, maxAttempts: 5 });
    const job = await claim("w", ["maintenance.retention"], 60_000);
    expect(await fail(job!.id, "w", "budget spent", { retryable: false })).toBe("failed");
  });

  it("puts a job back when its worker's lease lapses", async () => {
    const { job } = await enqueue({ kind: "maintenance.retention", userId: null });
    await claim("dead-worker", ["maintenance.retention"], 60_000);
    await pool.query(`UPDATE jobs SET locked_until = now() - interval '1 second' WHERE id = $1`, [job.id]);
    expect(await reapExpired()).toBe(1);
    const again = await claim("live-worker", ["maintenance.retention"], 60_000);
    expect(again?.id).toBe(job.id);
    // the dead worker can no longer write a result for it
    await succeed(job.id, "dead-worker", { stale: true });
    expect((await getJobById(job.id))!.status).toBe("running");
  });

  it("uses exponential backoff with jitter", () => {
    expect(backoffSeconds(1, () => 0.5)).toBe(30);
    expect(backoffSeconds(2, () => 0.5)).toBe(120);
    expect(backoffSeconds(10, () => 0.5)).toBe(3600);
    expect(backoffSeconds(1, () => 0)).toBe(23);
  });

  it("runs a job end to end and records its events", async () => {
    const { job } = await enqueue({ kind: "maintenance.retention", userId: null });
    const claimed = await claim("w", ["maintenance.retention"], 60_000);
    await processJob(claimed!, "w", 60_000);
    const done = await getJobById(job.id);
    expect(done!.status).toBe("succeeded");
    const evs = await eventsAfter(job.id, 0);
    expect(evs.at(-1)!.event).toMatchObject({ type: "job", status: "succeeded" });
  });

  it("schedules each slot once however many workers tick", async () => {
    await signedInUser();
    const now = new Date("2026-10-06T12:00:00Z");
    const results = await Promise.all([scheduleTick(now), scheduleTick(now), scheduleTick(now)]);
    const all = results.flat();
    expect(all.filter((x) => x.startsWith("autopilot:"))).toHaveLength(2); // the legacy owner and the new user
    expect(all.filter((x) => x === "maintenance.recheck")).toHaveLength(1);
    expect(all.filter((x) => x === "maintenance.retention")).toHaveLength(1);
    expect(await claimScheduleSlot("maintenance.recheck", "2026-10-06T12")).toBe(false);
  });
});

describe("job API", () => {
  it("streams a job's events as SSE and ends when it is finished", async () => {
    const u = await signedInUser();
    const { job } = await enqueue({ kind: "maintenance.retention", userId: u.userId });
    const claimed = await claim("w", ["maintenance.retention"], 60_000);
    await processJob(claimed!, "w", 60_000);

    const res = await call(events, { cookie: u.cookie, params: { id: job.id } });
    expect(res.status).toBe(200);
    const text = String(res.body);
    const data = text
      .split("\n")
      .filter((l) => l.startsWith("data: {"))
      .map((l) => JSON.parse(l.slice(6)));
    expect(data).toContainEqual(expect.objectContaining({ type: "job", status: "succeeded" }));
    expect(text).toMatch(/event: end/);
  });

  it("resumes from Last-Event-ID", async () => {
    const u = await signedInUser();
    const { job } = await enqueue({ kind: "maintenance.retention", userId: u.userId });
    await pool.query(`INSERT INTO job_events (job_id, event) VALUES ($1, '{"n":1}'), ($1, '{"n":2}')`, [job.id]);
    await pool.query(`UPDATE jobs SET status = 'succeeded', finished_at = now() WHERE id = $1`, [job.id]);
    const { rows } = await pool.query(`SELECT min(id)::int AS first FROM job_events WHERE job_id = $1`, [job.id]);
    const res = await call(events, { cookie: u.cookie, params: { id: job.id }, headers: { "last-event-id": String(rows[0].first) } });
    expect(String(res.body)).not.toMatch(/"n":1/);
    expect(String(res.body)).toMatch(/"n":2/);
  });

  it("does not show one person's job to another", async () => {
    const alice = await signedInUser();
    const bob = await signedInUser();
    const { job } = await enqueue({ kind: "maintenance.retention", userId: alice.userId });
    expect((await call(getJobRoute, { cookie: bob.cookie, params: { id: job.id } })).status).toBe(404);
    expect((await call(events, { cookie: bob.cookie, params: { id: job.id } })).status).toBe(404);
  });
});
