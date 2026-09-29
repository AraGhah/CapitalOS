import type { NextRequest } from "next/server";
import { listAlerts, setAlertStatus } from "@/lib/autopilot/cycle";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const status = req.nextUrl.searchParams.get("status");
  return Response.json({
    alerts: await listAlerts({ status: status === "new" || status === "seen" || status === "dismissed" ? status : undefined }),
  });
}

export async function PATCH(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { id?: string; status?: string };
  const status = body.status === "seen" || body.status === "dismissed" || body.status === "new" ? body.status : null;
  if (!body.id || !/^[0-9a-f-]{36}$/i.test(body.id) || !status) {
    return Response.json({ error: "an id and a status of new, seen or dismissed are required" }, { status: 400 });
  }
  const ok = await setAlertStatus(body.id, status);
  return ok ? Response.json({ ok }) : Response.json({ error: "no such alert" }, { status: 404 });
}
