import { route } from "@/lib/http/route";
import { notFound, parseJson } from "@/lib/http/errors";
import { AlertStatus } from "@/lib/http/schemas";
import { listAlerts, setAlertStatus } from "@/lib/autopilot/cycle";

export const dynamic = "force-dynamic";

export const GET = route(async (req, { actor }) => {
  const status = req.nextUrl.searchParams.get("status");
  return Response.json({
    alerts: await listAlerts(actor.userId, {
      status: status === "new" || status === "seen" || status === "dismissed" ? status : undefined,
    }),
  });
});

export const PATCH = route(async (req, { actor }) => {
  const { id, status } = await parseJson(req, AlertStatus);
  if (!(await setAlertStatus(actor.userId, id, status))) throw notFound("no such alert");
  return Response.json({ ok: true });
});
