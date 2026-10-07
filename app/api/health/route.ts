export const dynamic = "force-dynamic";

// Liveness: the process is up and answering. Says nothing about its
// dependencies, so an orchestrator does not restart a healthy server because
// the database blinked; that is what /api/ready is for.
export function GET() {
  return Response.json({ status: "ok", uptimeSeconds: Math.round(process.uptime()) });
}
