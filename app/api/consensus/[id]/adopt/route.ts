import type { NextRequest } from "next/server";
import { getCompanyForRun, getRun } from "@/lib/ai/store";
import { findOpenThesis, openThesis, parseRules } from "@/lib/theses";
import { addJournal } from "@/lib/ai/journal";

export const dynamic = "force-dynamic";

// Turns a committee's invalidation conditions into a thesis the desk monitors.
// Only complete rules are carried over, and they go through the same parseRules
// the MCP server uses, so a thesis opened here is checked exactly like any other.
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const run = await getRun(id);
  if (!run || run.summary.status !== "done" || !run.report) {
    return Response.json({ error: "no finished run with that id" }, { status: 404 });
  }
  const company = await getCompanyForRun(id);
  if (!company) return Response.json({ error: "no finished run with that id" }, { status: 404 });

  const rules = run.report.adoptableRules.map((r) => ({ metric: r.metric, operator: r.operator, value: r.value }));
  let parsed;
  try {
    parsed = parseRules(rules);
  } catch (err) {
    return Response.json(
      { error: `this committee left no rule a filing can check: ${(err as Error).message}` },
      { status: 422 }
    );
  }

  const existing = await findOpenThesis(company.companyId, parsed);
  if (existing) {
    return Response.json({ thesisId: existing, rules: parsed, alreadyOpen: true }, { status: 200 });
  }

  const rationale = run.report.synthesis?.thesis || run.report.synthesis?.headline || null;
  const thesisId = await openThesis(company.companyId, rationale, parsed);

  await addJournal({
    companyId: company.companyId,
    kind: "thesis-opened",
    title: `Thesis opened on ${company.ticker} from the committee`,
    detail: `${parsed.length} invalidation ${parsed.length === 1 ? "rule" : "rules"}: ${parsed
      .map((r) => `${r.metric} ${r.operator} ${r.value}`)
      .join("; ")}`,
    refId: thesisId,
  });

  return Response.json({ thesisId, rules: parsed }, { status: 201 });
}
