import { timingSafeEqual } from "node:crypto";
import { collectMetrics } from "@/lib/metrics-export";

export const dynamic = "force-dynamic";

// Prometheus text exposition. Not public: scrapers present METRICS_TOKEN as a
// bearer token, and without one configured the endpoint is off.
export async function GET(req: Request) {
  const token = process.env.METRICS_TOKEN?.trim();
  if (!token) return new Response("metrics are disabled; set METRICS_TOKEN", { status: 404 });
  const given = Buffer.from(req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "");
  const expected = Buffer.from(token);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return new Response("unauthorized", { status: 401 });
  }
  return new Response(await collectMetrics(), {
    headers: { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" },
  });
}
