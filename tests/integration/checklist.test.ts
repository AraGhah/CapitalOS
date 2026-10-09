import { describe, expect, it } from "vitest";
import { GET as getProfileRoute, PATCH as patchProfile } from "../../app/api/profile/route";
import { GET as getChecklist } from "../../app/api/checklist/[ticker]/route";
import { call, signedInUser } from "./helpers";
import { company } from "./db";

describe("investor profile and pre-investment checklist", () => {
  it("starts empty, saves a patch, and clears a field with null", async () => {
    const u = await signedInUser();
    const empty = await call(getProfileRoute, { cookie: u.cookie });
    expect(empty.status).toBe(200);
    expect((empty.body as { horizonYears: number | null }).horizonYears).toBeNull();

    const saved = await call(patchProfile, {
      method: "PATCH",
      cookie: u.cookie,
      body: { horizonYears: 20, maxLossShare: 0.4, objective: "retirement", institutionVerified: true },
    });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ horizonYears: 20, maxLossShare: 0.4, objective: "retirement", institutionVerified: true });

    const cleared = await call(patchProfile, { method: "PATCH", cookie: u.cookie, body: { horizonYears: null } });
    expect(cleared.body).toMatchObject({ horizonYears: null, maxLossShare: 0.4 });
  });

  it("refuses values outside their range and unknown fields", async () => {
    const u = await signedInUser();
    expect((await call(patchProfile, { method: "PATCH", cookie: u.cookie, body: { maxLossShare: 1.5 } })).status).toBe(400);
    expect((await call(patchProfile, { method: "PATCH", cookie: u.cookie, body: { objective: "lottery" } })).status).toBe(400);
    expect((await call(patchProfile, { method: "PATCH", cookie: u.cookie, body: { userId: "someone-else" } })).status).toBe(400);
  });

  it("keeps one person's profile from another", async () => {
    const a = await signedInUser();
    const b = await signedInUser();
    await call(patchProfile, { method: "PATCH", cookie: a.cookie, body: { emergencyFund: 9000 } });
    const seen = await call(getProfileRoute, { cookie: b.cookie });
    expect((seen.body as { emergencyFund: number | null }).emergencyFund).toBeNull();
  });

  it("builds a checklist that asks the person before it judges the stock", async () => {
    const u = await signedInUser();
    await company("CHKL");
    const res = await call(getChecklist, { cookie: u.cookie, params: { ticker: "CHKL" }, path: "/api/checklist/CHKL?size=1000" });
    expect(res.status).toBe(200);
    const body = res.body as { items: Array<{ id: string; status: string }>; verdict: { level: string }; positionSize: number };
    expect(body.items).toHaveLength(24);
    expect(body.positionSize).toBe(1000);
    expect(body.items.find((i) => i.id === "emergency_savings")?.status).toBe("input");
    // no filings stored for the company: missing, never a pass
    expect(body.items.find((i) => i.id === "profitability")?.status).toBe("missing");
    expect(body.verdict.level).toBe("incomplete");
  });

  it("is a 404 for a company the desk does not have", async () => {
    const u = await signedInUser();
    const res = await call(getChecklist, { cookie: u.cookie, params: { ticker: "NOPE" } });
    expect(res.status).toBe(404);
  });
});
