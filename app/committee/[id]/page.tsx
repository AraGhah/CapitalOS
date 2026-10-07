import { requirePageActor } from "@/lib/auth/current";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getRun } from "@/lib/ai/store";
import { ConsensusReportView } from "@/app/components/ConsensusReport";

export const dynamic = "force-dynamic";

export default async function CommitteeRunPage({ params }: PageProps<"/committee/[id]">) {
  const { id } = await params;
  const { actor } = await requirePageActor();
  const run = await getRun(actor.userId, id);
  if (!run) notFound();

  const { summary, report } = run;

  return (
    <div>
      <div className="page-head">
        <div>
          <p className="eyebrow">
            <Link href="/committee">Investment Committee</Link>
            {summary.focus ? ` · ${summary.focus}` : ""}
          </p>
          <h1>
            <Link href={`/research/${summary.ticker}`} className="num">
              {summary.ticker}
            </Link>{" "}
            <span style={{ fontWeight: 400, color: "var(--muted)" }}>{summary.name}</span>
          </h1>
        </div>
        <Link href={`/committee?ticker=${summary.ticker}`} className="chip">
          Convene again
        </Link>
      </div>

      {summary.status === "running" && (
        <p className="subtle">
          This committee is still sitting. Refresh in a moment — {run.calls.length} model calls are in the ledger so
          far.
        </p>
      )}
      {summary.status === "failed" && <p className="alert">This run failed: {summary.error}</p>}

      {report && (
        <ConsensusReportView
          runId={summary.id}
          report={report}
          evidence={run.evidence}
          calls={run.calls}
          createdAt={summary.createdAt}
        />
      )}
    </div>
  );
}
