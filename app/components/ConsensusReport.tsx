import Link from "next/link";
import type { ConsensusReport as Report, ReportClaim } from "@/lib/ai/report";
import type { EvidencePack } from "@/lib/ai/evidence";
import type { StoredCall } from "@/lib/ai/store";
import type { CheckVerdict } from "@/lib/ai/factcheck";
import type { DimensionResult } from "@/lib/ai/consensus";
import { formatValue } from "@/lib/ai/evidence";
import { modeSpec } from "@/lib/ai/modes";
import { AdoptThesis } from "./AdoptThesis";
import { PaperOrder } from "./PaperOrder";

/* ---------------------------------------------------------------------------
   The Capital Consensus, as the person reads it: the conclusion first, then
   everything that would let them disagree with it — where the models split,
   what the debate turned on, which claims failed, what evidence was read, and
   what it cost.
--------------------------------------------------------------------------- */

const VERDICT_TONE: Record<CheckVerdict, string> = {
  verified: "good",
  sourced: "info",
  miscited: "warn",
  unsupported: "bad",
  contradicted: "bad",
  unsourced: "",
};

const RATING_TONE: Record<string, string> = {
  strong: "good",
  positive: "good",
  mixed: "",
  negative: "bad",
  weak: "bad",
  unknown: "",
};

function Ev({ ids }: { ids: string[] }) {
  if (ids.length === 0) return null;
  return (
    <>
      {ids.map((id) => (
        <a key={id} className="ev" href={`#${id}`}>
          {id}
        </a>
      ))}
    </>
  );
}

function ConfidenceRing({ score }: { score: number }) {
  const size = 74;
  const stroke = 7;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  return (
    <div className="ring">
      <svg width={size} height={size} role="img" aria-label={`confidence ${Math.round(score * 100)} of 100`}>
        <circle className="track" cx={size / 2} cy={size / 2} r={radius} fill="none" strokeWidth={stroke} />
        <circle
          className="fill"
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={stroke}
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - score)}
        />
      </svg>
    </div>
  );
}

export function ConsensusReportView({
  runId,
  report,
  evidence,
  calls,
  createdAt,
}: {
  runId: string;
  report: Report;
  evidence: EvidencePack;
  calls: StoredCall[];
  createdAt: string;
}) {
  const s = report.synthesis;
  const standing = report.claims.filter(
    (c) => c.check.verdict !== "unsupported" && c.check.verdict !== "contradicted" && c.judge?.verdict !== "reject"
  );
  const removed = report.claims.length - standing.length;

  return (
    <div className="stack">
      {report.degraded.length > 0 && (
        <div className="alert" style={{ alignItems: "flex-start", flexDirection: "column", gap: "0.2rem" }}>
          {report.degraded.map((d, i) => (
            <span key={i}>{d}</span>
          ))}
        </div>
      )}

      {/* ---------------------------------------------------- the conclusion */}
      <section className="panel">
        <div className="panel-head">
          <h2>Capital Consensus</h2>
          <span className="hint">
            {modeSpec(report.mode).label} · {createdAt.slice(0, 16).replace("T", " ")} UTC
          </span>
        </div>
        <div className="verdict" style={{ alignItems: "flex-start" }}>
          <ConfidenceRing score={report.confidence.score} />
          <div style={{ minWidth: 0 }}>
            <span className="label" style={{ fontSize: "0.7rem", color: "var(--faint)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
              Confidence
            </span>
            <div className="verdict-word" style={{ fontSize: "1.25rem" }}>
              {report.confidence.label}
            </div>
            <details className="why-box">
              <summary>Why?</summary>
              <ul className="why">
                {report.confidence.reasons.map((r, i) => (
                  <li key={i}>
                    <span className={r.ok ? "mark-ok" : "mark-warn"}>{r.ok ? "✓" : "⚠"}</span>
                    <span>{r.text}</span>
                  </li>
                ))}
              </ul>
              <p className="subtle" style={{ marginTop: "0.5rem" }}>
                Computed by code, not reported by a model: agreement between seats, the share of testable claims
                that held, the share citing real evidence, and how much of the expected evidence was present.
              </p>
            </details>
          </div>
        </div>
        {s && (
          <div className="panel-body" style={{ borderTop: "1px solid var(--border)" }}>
            {s.headline && <p className="brief-headline">{s.headline}</p>}
            {s.thesis && <p className="brief-body">{s.thesis}</p>}
            {report.focus && s.answer && (
              <div className="brief-plan">
                <span className="label">{report.focus}</span>
                {s.answer}
              </div>
            )}
            {report.unverifiedFigures.length > 0 && (
              <p className="alert" style={{ marginTop: "0.7rem" }}>
                These figures in the conclusion are not in the evidence, even after the synthesizer was sent back:{" "}
                {report.unverifiedFigures.join(", ")}. Treat them as unverified.
              </p>
            )}
            <p className="subtle" style={{ marginTop: "0.7rem" }}>
              {report.synthesisBy?.kind === "synthesizer"
                ? `Written by the synthesizer (${report.synthesisBy.modelLabel}) from ${standing.length} claims that survived the fact check${removed ? `; ${removed} were removed` : ""}.`
                : report.synthesisBy
                  ? `A single analyst's view (${report.synthesisBy.modelLabel}), passed through with failed claims removed.`
                  : null}{" "}
              A summary of evidence, not financial advice.
            </p>
          </div>
        )}
        {s && (
          <div className="panel-body" style={{ borderTop: "1px solid var(--border)" }}>
            <PaperOrder ticker={report.ticker} runId={runId} rationale={s.headline || s.thesis} compact />
            <p className="subtle" style={{ marginTop: "0.4rem" }}>
              Test this conclusion with simulated money; it is scored against SPY on{" "}
              <Link href="/paper">Paper Trading</Link>.
            </p>
          </div>
        )}
        {report.adoptableRules.length > 0 && (
          <div className="panel-body" style={{ borderTop: "1px solid var(--border)" }}>
            <AdoptThesis
              runId={runId}
              rules={report.adoptableRules.map((r) => `${r.metric} ${r.operator} ${r.value}`)}
            />
          </div>
        )}
      </section>

      {/* ------------------------------------------------------ agreement */}
      <section className="panel">
        <div className="panel-head">
          <h2>Where the models agree</h2>
          <span className="hint">agreement between seats, dots show each seat on −2…+2</span>
        </div>
        <div>
          {report.dimensions.map((d) => (
            <AgreementRow key={d.key} d={d} />
          ))}
        </div>
      </section>

      {/* ------------------------------------------------------------ cases */}
      {s && (s.cases.bull || s.cases.base || s.cases.bear) && (
        <section className="panel">
          <div className="panel-head">
            <h2>Scenarios</h2>
            <span className="hint">conditions, not forecasts</span>
          </div>
          <div className="panel-body three-up">
            <Case title="Bull case" kind="bull" text={s.cases.bull} />
            <Case title="Base case" kind="watch" text={s.cases.base} />
            <Case title="Bear case" kind="bear" text={s.cases.bear} />
          </div>
        </section>
      )}

      {s && (s.risks.length > 0 || s.catalysts.length > 0 || s.monitor.length > 0) && (
        <section className="panel">
          <div className="panel-head">
            <h2>Risks, catalysts and what to watch</h2>
          </div>
          <div className="panel-body three-up">
            <div>
              <h2 style={{ marginBottom: "0.5rem" }}>Risks</h2>
              <ul className="case-list bear">
                {s.risks.map((r, i) => (
                  <li key={i}>
                    {r.text}{" "}
                    <span className={`pill ${r.severity === "high" ? "bad" : r.severity === "low" ? "" : "warn"}`.trim()}>
                      {r.severity}
                    </span>{" "}
                    <Ev ids={r.evidence} />
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h2 style={{ marginBottom: "0.5rem" }}>Catalysts</h2>
              {s.catalysts.length === 0 ? (
                <p className="missing">None recorded.</p>
              ) : (
                <ul className="case-list bull">
                  {s.catalysts.map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <h2 style={{ marginBottom: "0.5rem" }}>Monitor</h2>
              {s.monitor.length === 0 ? (
                <p className="missing">None recorded.</p>
              ) : (
                <ul className="case-list watch">
                  {s.monitor.map((m, i) => (
                    <li key={i}>{m}</li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </section>
      )}

      {/* --------------------------------------------------- disagreements */}
      {(report.disagreements.length > 0 || s?.primaryDisagreement || report.criticalUncertainty) && (
        <section className="panel">
          <div className="panel-head">
            <h2>Disagreements</h2>
            <span className="hint">kept on the record, not smoothed over</span>
          </div>
          <div className="panel-body stack-sm">
            {s?.primaryDisagreement && (
              <p>
                <strong>Primary disagreement.</strong> {s.primaryDisagreement}
              </p>
            )}
            {report.criticalUncertainty && (
              <p>
                <strong>Critical uncertainty.</strong> {report.criticalUncertainty}
              </p>
            )}
            {report.disagreements.map((d, i) => (
              <div key={i} className="claim">
                <p>
                  <strong>{d.topic}</strong>
                </p>
                <ul className="case-list">
                  {d.sides.map((side, j) => (
                    <li key={j}>{side}</li>
                  ))}
                </ul>
                {d.whyItMatters && <p className="subtle">{d.whyItMatters}</p>}
                {d.wouldResolve && <p className="subtle">Would settle it: {d.wouldResolve}</p>}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ------------------------------------------------------- the debate */}
      {(report.debate.bull || report.debate.bear || report.challenger) && (
        <section className="panel">
          <div className="panel-head">
            <h2>Debate room</h2>
            <span className="hint">each argument fact-checked like any other claim</span>
          </div>
          {(report.debate.bull || report.debate.bear) && (
            <div className="debate">
              <Advocate title="Bull" prefix="BULL" side={report.debate.bull} claims={report.claims} />
              <Advocate title="Bear" prefix="BEAR" side={report.debate.bear} claims={report.claims} />
            </div>
          )}
          {report.challenger && (
            <div className="panel-body" style={{ borderTop: "1px solid var(--border)" }}>
              <h2 style={{ marginBottom: "0.5rem" }}>
                Challenger <span className="subtle">· {report.challenger.modelLabel}</span>
              </h2>
              {report.challenger.challenges.map((c, i) => (
                <div key={i} className="argument">
                  <strong>{c.target}:</strong> {c.question}
                  <div className="meta">
                    <span className="subtle">{c.why}</span> <Ev ids={c.evidence} />
                  </div>
                </div>
              ))}
              {report.challenger.pricedIn && <p className="side-note">What the price assumes: {report.challenger.pricedIn}</p>}
              {report.challenger.blindSpot && <p className="side-note">Blind spot: {report.challenger.blindSpot}</p>}
            </div>
          )}
        </section>
      )}

      {/* -------------------------------------------------- model comparison */}
      <section className="panel">
        <div className="panel-head">
          <h2>Model comparison</h2>
          <span className="hint">accuracy from the checker; the rest from the judge, out of 10</span>
        </div>
        <div className="panel-scroll">
          <table>
            <thead>
              <tr>
                <th>Seat</th>
                <th>Model</th>
                <th>Claims</th>
                <th>Verified</th>
                <th>Failed</th>
                <th>Accuracy</th>
                <th>Logic</th>
                <th>Finance</th>
                <th>Risk</th>
                <th>Complete</th>
                <th>Overall</th>
              </tr>
            </thead>
            <tbody>
              {report.scorecards.map((card) => (
                <tr key={card.letter}>
                  <td>Analyst {card.letter}</td>
                  <td>{card.modelLabel}</td>
                  <td className="num">{card.claims}</td>
                  <td className="num">{card.verified}</td>
                  <td className={`num ${card.failed > 0 ? "down" : ""}`}>{card.failed}</td>
                  <td className="num">{card.accuracy === null ? "—" : `${Math.round(card.accuracy * 100)}%`}</td>
                  <td className="num">{card.grades.logic ?? "—"}</td>
                  <td className="num">{card.grades.financial_reasoning ?? "—"}</td>
                  <td className="num">{card.grades.risk_awareness ?? "—"}</td>
                  <td className="num">{card.grades.completeness ?? "—"}</td>
                  <td className="num">{card.overall === null ? "—" : card.overall.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {[...report.analysts, ...report.specialists].map((seat) => (
          <details key={seat.letter}>
            <summary>
              <span>
                {seat.name} <span className="subtle">· {seat.modelLabel}</span>
              </span>
              <span className={`pill ${seat.ok ? "good" : "bad"}`}>{seat.ok ? "answered" : "failed"}</span>
            </summary>
            <div className="panel-body">
              {seat.ok ? (
                <>
                  <p className="brief-body">{seat.summary}</p>
                  {seat.thesis && <p className="subtle" style={{ marginTop: "0.4rem" }}>Thesis: {seat.thesis}</p>}
                </>
              ) : (
                <p className="missing">{seat.error}</p>
              )}
            </div>
          </details>
        ))}
      </section>

      {/* ------------------------------------------------------ fact check */}
      <section className="panel">
        <div className="panel-head">
          <h2>Fact check</h2>
          <span className="hint">
            {report.checks.verified} verified · {report.checks.sourced} sourced · {report.checks.miscited} miscited ·{" "}
            {report.checks.unsupported + report.checks.contradicted} failed
          </span>
        </div>
        {report.claims.length === 0 ? (
          <p className="missing" style={{ padding: "0.9rem" }}>
            No claims were made.
          </p>
        ) : (
          <div style={{ maxHeight: "32rem", overflowY: "auto" }}>
            {report.claims.map((c) => (
              <ClaimLine key={c.key} c={c} />
            ))}
          </div>
        )}
      </section>

      {/* ------------------------------------------------ memory & invalidation */}
      {s && (s.invalidation.length > 0 || s.assumptions.length > 0) && (
        <section className="panel">
          <div className="panel-head">
            <h2>Thesis invalidation and assumptions</h2>
            <span className="hint">
              remembered, and settled by the next annual filing — see <Link href="/journal">Journal & Memory</Link>
            </span>
          </div>
          <div className="panel-body three-up">
            <div>
              <h2 style={{ marginBottom: "0.5rem" }}>What would prove it wrong</h2>
              <RuleList rules={s.invalidation} />
            </div>
            <div>
              <h2 style={{ marginBottom: "0.5rem" }}>What it assumes</h2>
              <RuleList rules={s.assumptions} />
            </div>
          </div>
        </section>
      )}

      {/* --------------------------------------------------------- evidence */}
      <section className="panel">
        <details>
          <summary>
            <span>
              <strong>Evidence pack</strong>{" "}
              <span className="subtle">
                · {evidence.items.length} items · {evidence.coverage.present}/{evidence.coverage.expected} inputs present
              </span>
            </span>
            <span className="subtle">every model read exactly this</span>
          </summary>
          <ul className="evidence-list">
            {evidence.items.map((item) => (
              <li key={item.id} id={item.id}>
                <span className="ev">{item.id}</span>
                <span>
                  {item.label}
                  {item.value !== undefined && <strong className="num"> {formatValue(item.value, item.unit)}</strong>}
                  {item.text && <span> — {item.text}</span>}
                  <span className="src">
                    {item.source.url ? (
                      <a href={item.source.url} target="_blank" rel="noreferrer">
                        {item.source.ref}
                      </a>
                    ) : (
                      item.source.ref
                    )}
                    {item.asOf ? ` · ${item.asOf}` : ""}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </details>
      </section>

      {/* ------------------------------------------------------ run ledger */}
      <section className="panel">
        <div className="panel-head">
          <h2>Run ledger</h2>
          <span className="hint">
            {report.cost.calls} calls · {(report.cost.inputTokens + report.cost.outputTokens).toLocaleString()} tokens
            {report.cost.cachedTokens > 0 && ` + ${report.cost.cachedTokens.toLocaleString()} from cache`} ·{" "}
            {report.cost.costUsd === null ? "unpriced" : `$${report.cost.costUsd.toFixed(4)}`}
            {report.cost.unpriced > 0 && report.cost.costUsd !== null && ` + ${report.cost.unpriced} unpriced calls`} ·{" "}
            {report.cost.seconds}s
          </span>
        </div>
        <div className="panel-scroll">
          <table>
            <thead>
              <tr>
                <th>Stage</th>
                <th>Seat</th>
                <th>Model</th>
                <th>In</th>
                <th>Out</th>
                <th>Cached</th>
                <th>Latency</th>
                <th>Cost</th>
              </tr>
            </thead>
            <tbody>
              {calls.map((c) => (
                <tr key={c.id}>
                  <td>{c.stage.replace("_", " ")}</td>
                  <td className="wide">
                    {c.agent}
                    {c.error && <span className="down"> — {c.error.slice(0, 80)}</span>}
                  </td>
                  <td>{c.model}</td>
                  <td className="num">{c.inputTokens.toLocaleString()}</td>
                  <td className="num">{c.outputTokens.toLocaleString()}</td>
                  <td className="num">{c.cachedTokens.toLocaleString()}</td>
                  <td className="num">{(c.latencyMs / 1000).toFixed(1)}s</td>
                  <td className="num">{c.costUsd === null ? "—" : `$${c.costUsd.toFixed(4)}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="subtle" style={{ padding: "0.7rem 0.9rem" }}>
          Metered per call from what each provider reported. Set <code>priceIn</code> and <code>priceOut</code> in{" "}
          <code>models.json</code> to see cost in dollars.
        </p>
      </section>
    </div>
  );
}

function AgreementRow({ d }: { d: DimensionResult }) {
  return (
    <div className="agree-row">
      <span>{d.label}</span>
      <span>
        <span className={`pill ${d.contested ? "warn" : RATING_TONE[d.rating]}`.trim()}>
          {d.contested ? `contested · ${d.label2}` : d.label2}
        </span>
      </span>
      {d.agreement === null ? (
        <span className="subtle">{d.votes.length === 1 ? "one seat scored this" : "not scored"}</span>
      ) : (
        <span
          className={`agree-bar ${d.contested ? "contested" : ""}`.trim()}
          role="img"
          aria-label={`${Math.round(d.agreement * 100)}% agreement`}
        >
          <span style={{ width: `${d.agreement * 100}%` }} />
        </span>
      )}
      <span className="pct">{d.agreement === null ? "—" : `${Math.round(d.agreement * 100)}%`}</span>
      {d.votes.length > 0 && (
        <div className="agree-note">
          <span className="votes" aria-hidden="true">
            {d.votes.map((v, i) => (
              <i key={i} style={{ left: `${((v.score + 2) / 4) * 100}%` }} title={`${v.seat}: ${v.score}`} />
            ))}
          </span>
          <span>{d.votes.map((v) => `${v.seat.replace("Analyst ", "")} ${v.score > 0 ? "+" : ""}${v.score}`).join(" · ")}</span>
          {d.note && <span>Judge: {d.note}</span>}
        </div>
      )}
    </div>
  );
}

function Case({ title, kind, text }: { title: string; kind: string; text: string }) {
  return (
    <div>
      <h2 style={{ marginBottom: "0.5rem" }}>{title}</h2>
      {text ? (
        <ul className={`case-list ${kind}`}>
          <li>{text}</li>
        </ul>
      ) : (
        <p className="missing">Not written.</p>
      )}
    </div>
  );
}

function Advocate({
  title,
  prefix,
  side,
  claims,
}: {
  title: string;
  prefix: string;
  side: Report["debate"]["bull"];
  claims: ReportClaim[];
}) {
  if (!side) {
    return (
      <div>
        <h2>{title}</h2>
        <p className="missing">This seat did not answer.</p>
      </div>
    );
  }
  const own = claims.filter((c) => c.key.startsWith(prefix));
  return (
    <div>
      <h2 style={{ marginBottom: "0.5rem" }}>
        {title} <span className="subtle">· {side.modelLabel}</span>
      </h2>
      {side.arguments.map((a, i) => {
        const claim = own[i];
        return (
          <div key={i} className="argument">
            {a.text}
            <div className="meta">
              <span className="strength" title="strength of evidence, 1 to 3">
                {"●".repeat(a.strength)}
                {"○".repeat(3 - a.strength)}
              </span>
              {claim && <span className={`pill ${VERDICT_TONE[claim.check.verdict]}`.trim()}>{claim.check.verdict}</span>}
              <Ev ids={a.evidence} />
            </div>
          </div>
        );
      })}
      {side.strongest && <p className="side-note">Strongest: {side.strongest}</p>}
      {side.concession && <p className="side-note">Concedes: {side.concession}</p>}
    </div>
  );
}

function ClaimLine({ c }: { c: ReportClaim }) {
  const out = c.check.verdict === "unsupported" || c.check.verdict === "contradicted" || c.judge?.verdict === "reject";
  return (
    <div className={`claim-row ${out ? "out" : ""}`.trim()}>
      <span className="key">{c.key}</span>
      <div>
        <p>{c.text}</p>
        <div className="meta">
          <span className={`pill ${VERDICT_TONE[c.check.verdict]}`.trim()}>{c.check.verdict}</span>
          {c.judge && <span className={`pill ${c.judge.verdict === "reject" ? "bad" : "warn"}`}>judge: {c.judge.verdict}</span>}
          <span>{c.seat}</span>
          <span>· {c.check.method === "code" ? "checked by code" : "checked by model"}: {c.check.reason}</span>
          {c.judge?.reason && <span>· {c.judge.reason}</span>}
          <Ev ids={c.evidence} />
        </div>
      </div>
    </div>
  );
}

function RuleList({ rules }: { rules: Array<{ text: string; metric: string | null; operator: string | null; value: number | null }> }) {
  if (rules.length === 0) return <p className="missing">None recorded.</p>;
  return (
    <ul className="case-list watch">
      {rules.map((r, i) => (
        <li key={i}>
          {r.text}{" "}
          {r.metric ? (
            <code>
              {r.metric} {r.operator} {r.value}
            </code>
          ) : (
            <span className="pill" title="no rule a filing can check">
              not testable
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}
