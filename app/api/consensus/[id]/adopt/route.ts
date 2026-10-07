import { route } from "@/lib/http/route";
import { HttpError, notFound } from "@/lib/http/errors";
import { getCompanyForRun, getRun } from "@/lib/ai/store";
import { findOpenThesis, openThesis, parseRules } from "@/lib/theses";
import { addJournal } from "@/lib/ai/journal";

export const dynamic = "force-dynamic";

// Turns a committee's invalidation conditions into a thesis the desk monitors.
// Only complete rules are carried over, and they go through the same parseRules
// the MCP server uses, so a thesis opened here is checked exactly like any other.
export const POST = route<{ id: string }>(async (_req, { actor, params }) => {
  const run = await getRun(actor.userId, params.id);
  if (!run || run.summary.status !== "done" || !run.report) throw notFound("no finished run with that id");
  const company = await getCompanyForRun(actor.userId, params.id);
  if (!company) throw notFound("no finished run with that id");

  const rules = run.report.adoptableRules.map((r) => ({ metric: r.metric, operator: r.operator, value: r.value }));
  let parsed;
  try {
    parsed = parseRules(rules);
  } catch (err) {
    throw new HttpError(422, `this committee left no rule a filing can check: ${(err as Error).message}`);
  }

  const existing = await findOpenThesis(actor.userId, company.companyId, parsed);
  if (existing) return Response.json({ thesisId: existing, rules: parsed, alreadyOpen: true });

  const rationale = run.report.synthesis?.thesis || run.report.synthesis?.headline || null;
  const thesisId = await openThesis(actor.userId, company.companyId, rationale, parsed);

  await addJournal({
    userId: actor.userId,
    companyId: company.companyId,
    kind: "thesis-opened",
    title: `Thesis opened on ${company.ticker} from the committee`,
    detail: `${parsed.length} invalidation ${parsed.length === 1 ? "rule" : "rules"}: ${parsed
      .map((r) => `${r.metric} ${r.operator} ${r.value}`)
      .join("; ")}`,
    refId: thesisId,
  });

  return Response.json({ thesisId, rules: parsed }, { status: 201 });
});
