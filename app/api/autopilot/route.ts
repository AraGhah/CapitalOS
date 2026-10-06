import type { NextRequest } from "next/server";
import { CycleBusyError, runCycle } from "@/lib/autopilot/cycle";

export const dynamic = "force-dynamic";
// A pass that convenes committees can take several minutes.
export const maxDuration = 800;

// One pass of the loop on demand, the same one `npm run autopilot` runs on a
// schedule. Convening is off unless the request asks for it.
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { convene?: boolean };
  try {
    return Response.json(await runCycle({ convene: body.convene === true }));
  } catch (err) {
    if (err instanceof CycleBusyError) return Response.json({ error: err.message }, { status: 409 });
    return Response.json({ error: err instanceof Error ? err.message : "the pass failed" }, { status: 500 });
  }
}
