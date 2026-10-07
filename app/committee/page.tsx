import { requirePageActor } from "@/lib/auth/current";
import Link from "next/link";
import { availableModels, listRegistry } from "@/lib/ai/models";
import { listRuns } from "@/lib/ai/store";
import { modeSpec } from "@/lib/ai/modes";
import { timeAgo } from "@/lib/format";
import { CommitteeLauncher } from "@/app/components/CommitteeLauncher";

export const dynamic = "force-dynamic";

export default async function CommitteePage({ searchParams }: PageProps<"/committee">) {
  const { ticker } = await searchParams;
  const models = availableModels();
  const registry = listRegistry();
  const { actor } = await requirePageActor();
  const runs = await listRuns(actor.userId, { limit: 25 });

  return (
    <div>
      <div className="page-head">
        <div>
          <p className="eyebrow">AI · Capital Intelligence Consensus</p>
          <h1>Investment Committee</h1>
        </div>
      </div>

      {models.length === 0 && (
        <p className="alert" style={{ marginBottom: "1rem" }}>
          No model is available. Add <code>ANTHROPIC_API_KEY</code> to <code>.env.local</code>, or the key and model for
          any provider listed in <code>models.json</code>.
        </p>
      )}

      <div className="split">
        <div className="stack">
          {models.length > 0 && (
            <CommitteeLauncher
              models={models.map((m) => ({ id: m.id, label: m.label, tier: m.tier, provider: m.provider }))}
              initialTicker={typeof ticker === "string" ? ticker.toUpperCase() : undefined}
            />
          )}

          <section className="panel">
            <div className="panel-head">
              <h2>Recent committees</h2>
              <span className="hint">every run is kept, with its evidence</span>
            </div>
            {runs.length === 0 ? (
              <p className="missing" style={{ padding: "0.9rem" }}>
                No committee has sat yet.
              </p>
            ) : (
              <div className="panel-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Ticker</th>
                      <th className="wide">Conclusion</th>
                      <th>Mode</th>
                      <th>Confidence</th>
                      <th>When</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runs.map((r) => (
                      <tr key={r.id}>
                        <td>
                          <Link href={`/committee/${r.id}`} className="sym">
                            {r.ticker}
                          </Link>
                        </td>
                        <td className="wide">
                          <Link href={`/committee/${r.id}`}>
                            {r.status === "done"
                              ? r.headline ?? "—"
                              : r.status === "running"
                                ? <span className="subtle">sitting now…</span>
                                : <span className="down">failed: {r.error?.slice(0, 90)}</span>}
                          </Link>
                          {r.focus && <div className="subtle">{r.focus}</div>}
                        </td>
                        <td>{modeSpec(r.mode).label}</td>
                        <td className="num">{r.confidence === null ? "—" : Math.round(r.confidence * 100)}</td>
                        <td className="subtle">{timeAgo(r.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>

        <div className="stack">
          <section className="panel">
            <div className="panel-head">
              <h2>How a committee sits</h2>
            </div>
            <div className="panel-body">
              <ol className="case-list watch" style={{ paddingLeft: 0 }}>
                <li>
                  <strong>Evidence.</strong> Code builds one pack — filings, computed ratios, prices, headlines, macro —
                  and every model reads the same one.
                </li>
                <li>
                  <strong>Blind analysis.</strong> Each model scores eight dimensions without seeing the others.
                </li>
                <li>
                  <strong>Debate.</strong> A bull and a bear argue from the analysts&apos; views; a challenger attacks the
                  emerging consensus.
                </li>
                <li>
                  <strong>Fact check.</strong> Every figure is tested against the evidence it cites, by code. A model
                  checks what code cannot.
                </li>
                <li>
                  <strong>Judge.</strong> Weighs the arguments, rules on weak claims, keeps disagreements on record.
                </li>
                <li>
                  <strong>Synthesis.</strong> Written only from what survived; any figure that fails goes back once for
                  correction.
                </li>
              </ol>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>Seats available</h2>
              <Link href="/ai" className="hint">
                models →
              </Link>
            </div>
            <ul className="rail">
              {registry.map((m) => (
                <li key={m.id}>
                  <span
                    className="dot idle"
                    style={{ background: m.available ? "var(--up)" : "var(--faint)" }}
                  />
                  <span className="feed-name" title={m.model ?? undefined}>
                    {m.label}
                  </span>
                  <span className={m.available ? "count" : "count offline"}>
                    {m.available ? m.tier : `needs ${m.missing}`}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}
