import Link from "next/link";
import { notFound } from "next/navigation";
import { getFilings, getPriceHistory } from "@/lib/company";
import { resolveCompany } from "@/lib/resolve";
import { RESEARCH_FIELDS, getResearchNote } from "@/lib/research";
import { getScores } from "@/lib/scoring";
import { getHeadlines, getLatestDossier } from "@/lib/dossier";
import { FEED_LABELS } from "@/lib/feeds";
import { timeAgo } from "@/lib/format";
import { CoverageRing, PercentileGauge, Meter } from "@/app/components/Readouts";
import { type PricePoint } from "@/app/components/PriceChart";
import { LivePrice } from "@/app/components/LivePrice";
import { DeskRunner } from "@/app/components/DeskRunner";
import { Wire } from "@/app/components/Wire";
import { listRuns } from "@/lib/ai/store";
import { modeSpec } from "@/lib/ai/modes";

export const dynamic = "force-dynamic";

const FIELD_LABELS: Record<string, string> = {
  outlook: "Outlook",
  catalysts: "Catalysts",
  risks: "Risks",
  bull_case: "Bull case",
  bear_case: "Bear case",
};

const PRICE_BARS = 22; // roughly one month of trading days

function label(component: string): string {
  return component.replace(/_/g, " ");
}

export default async function ResearchPage({ params }: PageProps<"/research/[ticker]">) {
  const { ticker } = await params;

  // A ticker the desk has not seen gets a companies row here, so searching one
  // lands on a page that can research it. A symbol nothing recognises is a 404.
  const company = await resolveCompany(ticker).catch(() => null);
  if (!company) notFound();

  const [note, headlines, dossier, bars, filings, scores, committees] = await Promise.all([
    getResearchNote(company.id, company.ticker, company.name),
    getHeadlines(company.id, 80),
    getLatestDossier(company.id),
    getPriceHistory(company.id, { limit: PRICE_BARS }),
    getFilings(company.id, { limit: 6 }),
    getScores(),
    listRuns({ companyId: company.id, limit: 3 }),
  ]);
  const lastCommittee = committees.find((r) => r.status === "done") ?? null;

  const { coverage } = note;
  const missingInputs = coverage.inputs.filter((i) => !i.present);
  const score = scores.find((s) => s.companyId === company.id) ?? null;

  // Stored bars, used only if Yahoo cannot be reached when the card mounts.
  const storedBars: PricePoint[] = bars.map((b) => {
    const low = b.low === null ? null : Number(b.low);
    const high = b.high === null ? null : Number(b.high);
    return {
      date: b.date.slice(5),
      close: b.close === null ? null : Number(b.close),
      low,
      range: low !== null && high !== null ? high - low : null,
    };
  });

  const wireItems = headlines.map((h) => ({
    id: h.id,
    title: h.title,
    url: h.url,
    ago: h.publishedAt ? timeAgo(h.publishedAt) : "undated",
    sentiment: h.sentiment,
    feed: FEED_LABELS[h.feed] ?? h.feed,
  }));

  const written = RESEARCH_FIELDS.filter((f) => note.fields[f].length > 0).length;

  return (
    <div>
      <div className="page-head">
        <div>
          <p className="eyebrow">
            {company.sector ?? "unclassified"}
            {company.industry ? ` · ${company.industry}` : ""}
          </p>
          <h1>
            <span className="num">{company.ticker}</span>{" "}
            <span style={{ fontWeight: 400, color: "var(--muted)" }}>{company.name}</span>
          </h1>
        </div>
      </div>

      <div className="split">
        <div className="stack">
          <DeskRunner ticker={company.ticker} initialDossier={dossier} />

          <section className="panel">
            <div className="panel-head">
              <h2>The wire</h2>
              <span className="hint">
                {headlines.length} headlines, filterable by outlet
              </span>
            </div>
            {headlines.length === 0 ? (
              <p className="missing" style={{ padding: "0.9rem" }}>
                No headlines stored — run the pipeline above to gather them.
              </p>
            ) : (
              <Wire items={wireItems} />
            )}
          </section>

          {RESEARCH_FIELDS.map((field) => {
            const claims = note.fields[field];
            if (claims.length === 0) return null;

            return (
              <section className="panel" key={field}>
                <div className="panel-head">
                  <h2>{FIELD_LABELS[field]}</h2>
                  <span className="hint">
                    {claims.length} {claims.length === 1 ? "claim" : "claims"}, each quoting its
                    source
                  </span>
                </div>
                <div className="panel-body">
                  {claims.map((claim) => (
                    <div key={claim.id} className="claim">
                      <p>{claim.text}</p>
                      <blockquote>{claim.snippet}</blockquote>
                      <a className="cite" href={claim.source.url} target="_blank" rel="noreferrer">
                        {claim.source.title ?? claim.source.url}
                      </a>
                    </div>
                  ))}
                </div>
              </section>
            );
          })}
        </div>

        <div className="stack">
          <LivePrice ticker={company.ticker} fallback={storedBars} />

          <section className="panel">
            <div className="panel-head">
              <h2>Investment committee</h2>
              {lastCommittee && <span className="hint">{timeAgo(lastCommittee.createdAt)}</span>}
            </div>
            <div className="panel-body stack-sm">
              {lastCommittee ? (
                <>
                  <p>
                    <Link href={`/committee/${lastCommittee.id}`}>{lastCommittee.headline ?? "Open the report"}</Link>
                  </p>
                  <p className="subtle">
                    {modeSpec(lastCommittee.mode).label}
                    {lastCommittee.confidence !== null &&
                      ` · confidence ${Math.round(lastCommittee.confidence * 100)}`}
                  </p>
                </>
              ) : (
                <p className="missing">
                  No committee yet. Several models analyse the same evidence blind, debate, and are fact-checked
                  before a conclusion is written.
                </p>
              )}
              <Link href={`/committee?ticker=${company.ticker}`} className="chip" style={{ alignSelf: "flex-start" }}>
                Convene a committee
              </Link>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>Coverage</h2>
              <span className="hint">what was retrieved</span>
            </div>
            <div className="panel-body">
              <CoverageRing present={coverage.present} expected={coverage.expected} />
              <p className="subtle" style={{ marginTop: "0.7rem" }}>
                {written} of {RESEARCH_FIELDS.length} sourced research fields written
                {coverage.scoreSpread !== null && (
                  <>
                    {" · "}
                    score components disagree by {(coverage.scoreSpread * 100).toFixed(0)} pts
                  </>
                )}
              </p>
              {missingInputs.length > 0 && (
                <p className="missing" style={{ marginTop: "0.4rem" }}>
                  Not retrieved: {missingInputs.map((i) => i.name).join(", ")}.
                </p>
              )}
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>Score</h2>
              {score && <span className="hint">as of {score.asOf}</span>}
            </div>
            <div className="panel-body">
              {score ? (
                <>
                  <div className="num" style={{ fontSize: "1.6rem" }}>
                    {score.total.toFixed(1)}
                  </div>
                  <PercentileGauge percentile={score.total} />
                  <table style={{ marginTop: "0.9rem" }}>
                    <tbody>
                      {score.components.map((c) => (
                        <tr key={c.component}>
                          <td className="wide" style={{ paddingLeft: 0 }}>
                            {label(c.component)}
                          </td>
                          <td>
                            <Meter share={c.percentile} />
                          </td>
                          <td className="num" style={{ paddingRight: 0 }}>
                            {(c.percentile * 100).toFixed(0)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="subtle" style={{ marginTop: "0.6rem" }}>
                    <Link href="/scores">Full breakdown</Link>
                  </p>
                </>
              ) : (
                <p className="missing">
                  Not scored — run <code>npm run ingest-edgar</code>, then{" "}
                  <code>npm run compute-scores</code>.
                </p>
              )}
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>Filings</h2>
              <span className="hint">most recent</span>
            </div>
            {filings.length === 0 ? (
              <p className="missing" style={{ padding: "0.9rem" }}>
                None indexed yet.
              </p>
            ) : (
              <ul className="rail">
                {filings.map((f) => (
                  <li key={f.id}>
                    <span className="feed-name">
                      {f.url ? (
                        <a href={f.url} target="_blank" rel="noreferrer">
                          {f.formType}
                        </a>
                      ) : (
                        f.formType
                      )}
                      {f.periodEnd && <span className="subtle"> · {f.periodEnd}</span>}
                    </span>
                    <span className="count">{f.filedAt}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
