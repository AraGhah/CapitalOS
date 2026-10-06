import type { NextRequest } from "next/server";
import { runConsensus, type RunEvent } from "@/lib/ai/committee";
import { isMode } from "@/lib/ai/modes";
import { listRuns } from "@/lib/ai/store";
import { findCompany } from "@/lib/company";

export const dynamic = "force-dynamic";
// A full committee is a dozen or more model calls in five phases.
export const maxDuration = 800;

export async function GET(req: NextRequest) {
  const ticker = req.nextUrl.searchParams.get("ticker");
  const company = ticker ? await findCompany(ticker) : null;
  if (ticker && !company) return Response.json({ runs: [] });
  return Response.json({ runs: await listRuns({ companyId: company?.id, limit: 30 }) });
}

// Streams newline-delimited JSON, one event per line, the same way the desk
// pipeline does: the page shows each seat answering as it actually happens.
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    ticker?: string;
    mode?: string;
    focus?: string;
    modelIds?: string[];
    force?: boolean;
  };

  const ticker = body.ticker?.trim();
  if (!ticker) return Response.json({ error: "ticker is required" }, { status: 400 });

  const mode = body.mode === "auto" ? "auto" : isMode(body.mode) ? body.mode : "standard";
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      // A closed tab cancels the stream, after which enqueue throws. The run is
      // already paying for its model calls, so it carries on and is saved; only
      // the progress lines stop.
      let open = true;
      const send = (event: RunEvent) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          open = false;
        }
      };
      try {
        await runConsensus(
          {
            ticker,
            mode,
            focus: typeof body.focus === "string" ? body.focus.slice(0, 400) : null,
            modelIds: Array.isArray(body.modelIds)
              ? body.modelIds.filter((id): id is string => typeof id === "string").slice(0, 20)
              : undefined,
            force: body.force === true,
          },
          send
        );
      } catch (err) {
        send({ type: "error", message: err instanceof Error ? err.message : String(err) });
      } finally {
        if (open) {
          try {
            controller.close();
          } catch {
            // already closed by the client
          }
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
    },
  });
}
