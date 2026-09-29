import Link from "next/link";
import { listAlerts, recentCycles, type AlertRow } from "@/lib/autopilot/cycle";
import { availableModels } from "@/lib/ai/models";
import { timeAgo } from "@/lib/format";
import { AlertStatus, RunCycle } from "@/app/components/AlertControls";

export const dynamic = "force-dynamic";

const TONE: Record<string, string> = { high: "bad", warn: "warn", info: "info" };

const LOOP = ["Discover", "Research", "Debate", "Verify", "Synthesize", "Track", "Monitor", "Learn"];

export default async function AlertsPage() {
  const [open, reviewed, cycles] = await Promise.all([
    listAlerts({ status: "new", limit: 100 }),
    listAlerts({ status: "seen", limit: 30 }),
    recentCycles(8),
  ]);
  const last = cycles[0];

  return (
    <div>
      <div className="page-head">
        <div>
          <p className="eyebrow">Intelligence · the autonomous loop</p>
          <h1>Alerts</h1>
        </div>
        <span className="subtle">
          {last ? `last pass ${timeAgo(last.startedAt)}` : "the loop has not run yet"}
        </span>
      </div>

      <div className="split">
        <div className="stack">
          <section className="panel">
            <div className="panel-head">
              <h2>Needs review</h2>
              <span className="hint">{open.length} open · most severe first</span>
            </div>
            {open.length === 0 ? (
              <p className="missing" style={{ padding: "0.9rem" }}>
                Nothing open. {cycles.length === 0 ? "Run a pass to start watching." : "The loop found nothing new."}
              </p>
            ) : (
              <div>
                {open.map((a) => (
                  <AlertLine key={a.id} a={a} />
                ))}
              </div>
            )}
          </section>

          {reviewed.length > 0 && (
            <section className="panel">
              <details>
                <summary>
                  <span>
                    <strong>Reviewed</strong> <span className="subtle">· {reviewed.length}</span>
                  </span>
                </summary>
                {reviewed.map((a) => (
                  <AlertLine key={a.id} a={a} />
                ))}
              </details>
            </section>
          )}
        </div>

        <div className="stack">
          <section className="panel">
            <div className="panel-head">
              <h2>Autopilot</h2>
            </div>
            <div className="panel-body stack-sm">
              <RunCycle hasModel={availableModels().length > 0} />
              <p className="subtle">
                Or leave it running: <code>npm run autopilot</code> passes every 30 minutes;{" "}
                <code>-- --convene</code> lets it convene committees, capped by <code>AUTOPILOT_MAX_COMMITTEES</code>.
              </p>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>The loop</h2>
            </div>
            <div className="panel-body stack-sm">
              <p className="subtle" style={{ fontFamily: "var(--mono)", fontSize: "0.72rem" }}>
                {LOOP.join(" → ")} → repeat
              </p>
              <p className="subtle">
                Each pass checks the tracked companies — held and watched — for unusual moves and volume, news surges
                and new filings; re-checks every thesis and remembered assumption; measures portfolio risk; and reads the
                market regime. Every trigger is a threshold on a computed number. A committee is convened only when you
                allow it.
              </p>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>Recent passes</h2>
            </div>
            {cycles.length === 0 ? (
              <p className="missing" style={{ padding: "0.9rem" }}>
                None yet.
              </p>
            ) : (
              <ul className="rail">
                {cycles.map((c) => (
                  <li key={c.id} title={c.error ?? c.summary?.errors.join("; ") ?? undefined}>
                    <span className="dot idle" style={{ background: c.error ? "var(--down)" : "var(--up)" }} />
                    <span className="feed-name">
                      {timeAgo(c.startedAt)}
                      {c.summary && <span className="subtle"> · {c.summary.found} triggers</span>}
                    </span>
                    <span className="count">{c.error ? "failed" : `${c.summary?.created ?? 0} new`}</span>
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

function AlertLine({ a }: { a: AlertRow }) {
  const effect = a.impact?.portfolio_effect;
  return (
    <div className="claim-row" style={{ gridTemplateColumns: "3.6rem minmax(0, 1fr) auto" }}>
      <span>
        <span className={`pill ${TONE[a.severity]}`}>{a.severity}</span>
      </span>
      <div>
        <p>
          {a.ticker && (
            <Link href={`/research/${a.ticker}`} className="num" style={{ fontWeight: 600 }}>
              {a.ticker}
            </Link>
          )}{" "}
          {a.title}
        </p>
        {a.detail && <p className="subtle">{a.detail}</p>}
        <div className="meta">
          <span>{timeAgo(a.createdAt)}</span>
          <span>· {a.kind.replace(/-/g, " ")}</span>
          {effect !== undefined && effect !== null && (
            <span className={effect >= 0 ? "up" : "down"}>
              · portfolio {effect >= 0 ? "+" : "−"}
              {Math.abs(effect * 100).toFixed(2)}%
              {a.impact?.dollars !== null && a.impact?.dollars !== undefined &&
                ` (${a.impact.dollars >= 0 ? "+" : "−"}$${Math.abs(a.impact.dollars).toLocaleString("en-US", { maximumFractionDigits: 0 })})`}
            </span>
          )}
          {a.runId ? (
            <Link href={`/committee/${a.runId}`}>· committee report →</Link>
          ) : (
            a.ticker && <Link href={`/committee?ticker=${a.ticker}`}>· convene a committee</Link>
          )}
        </div>
      </div>
      <AlertStatus id={a.id} status={a.status} />
    </div>
  );
}
