import { requirePageActor } from "@/lib/auth/current";
import Link from "next/link";
import { listMemory } from "@/lib/ai/memory";
import { listJournal } from "@/lib/ai/journal";
import { JournalNote } from "@/app/components/JournalNote";

export const dynamic = "force-dynamic";

const KIND_LABEL: Record<string, { label: string; tone: string }> = {
  committee: { label: "committee", tone: "info" },
  "thesis-opened": { label: "thesis", tone: "good" },
  "thesis-invalidated": { label: "thesis broke", tone: "bad" },
  "memory-supported": { label: "held", tone: "good" },
  "memory-refuted": { label: "broke", tone: "bad" },
  note: { label: "note", tone: "" },
  "paper-trade": { label: "paper", tone: "info" },
  alert: { label: "alert", tone: "warn" },
};

const STATUS_TONE: Record<string, string> = {
  pending: "",
  supported: "good",
  refuted: "bad",
  untestable: "",
};

export default async function JournalPage() {
  const { actor } = await requirePageActor();
  const [entries, memory] = await Promise.all([
    listJournal(actor.userId, { limit: 100 }),
    listMemory(actor.userId, { limit: 100 }),
  ]);
  const pending = memory.filter((m) => m.status === "pending").length;
  const settled = memory.filter((m) => m.status === "supported" || m.status === "refuted");

  return (
    <div>
      <div className="page-head">
        <div>
          <p className="eyebrow">Intelligence · what was decided, and what the desk remembers</p>
          <h1>Journal &amp; Memory</h1>
        </div>
      </div>

      <div className="split">
        <div className="stack">
          <section className="panel">
            <div className="panel-head">
              <h2>Decision journal</h2>
              <span className="hint">written by the code paths that did the thing</span>
            </div>
            {entries.length === 0 ? (
              <p className="missing" style={{ padding: "0.9rem" }}>
                Nothing recorded yet. Committees, theses and settled assumptions land here as they happen.
              </p>
            ) : (
              <ul className="timeline">
                {entries.map((e) => {
                  const kind = KIND_LABEL[e.kind] ?? { label: e.kind, tone: "" };
                  const href = e.kind === "committee" && e.refId ? `/committee/${e.refId}` : null;
                  return (
                    <li key={e.id}>
                      <time dateTime={e.createdAt}>{e.createdAt.slice(0, 10)}</time>
                      <div>
                        <span className={`pill ${kind.tone}`.trim()}>{kind.label}</span>{" "}
                        {e.ticker && (
                          <Link href={`/research/${e.ticker}`} className="num">
                            {e.ticker}
                          </Link>
                        )}{" "}
                        {href ? <Link href={href}>{e.title}</Link> : e.title}
                        {e.detail && <span className="detail">{e.detail}</span>}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>AI memory</h2>
              <span className="hint">
                {pending} waiting for a newer filing · {settled.length} settled
              </span>
            </div>
            {memory.length === 0 ? (
              <p className="missing" style={{ padding: "0.9rem" }}>
                No assumptions remembered yet. Each committee&apos;s assumptions and invalidation conditions are kept here and
                settled by arithmetic when a later annual filing arrives.
              </p>
            ) : (
              <div className="panel-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Ticker</th>
                      <th className="wide">Statement</th>
                      <th>Rule</th>
                      <th>Made from</th>
                      <th>Actual</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {memory.map((m) => (
                      <tr key={m.id}>
                        <td>
                          <Link href={`/research/${m.ticker}`} className="sym">
                            {m.ticker}
                          </Link>
                        </td>
                        <td className="wide">
                          <span className="subtle">{m.kind === "invalidation" ? "breaks if: " : "assumes: "}</span>
                          {m.runId ? <Link href={`/committee/${m.runId}`}>{m.statement}</Link> : m.statement}
                        </td>
                        <td>
                          {m.metric ? (
                            <code>
                              {m.metric} {m.operator} {m.value}
                            </code>
                          ) : (
                            <span className="subtle">—</span>
                          )}
                        </td>
                        <td className="num">{m.baselinePeriod ?? "—"}</td>
                        <td className="num">
                          {m.actual === null ? "—" : `${m.actual.toPrecision(4)} (${m.checkedPeriod})`}
                        </td>
                        <td>
                          <span className={`pill ${STATUS_TONE[m.status]}`.trim()}>
                            {m.status === "supported"
                              ? m.kind === "invalidation"
                                ? "thesis held"
                                : "held"
                              : m.status === "refuted"
                                ? m.kind === "invalidation"
                                  ? "thesis broke"
                                  : "broke"
                                : m.status}
                          </span>
                        </td>
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
              <h2>Write a decision down</h2>
            </div>
            <JournalNote />
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>How memory is settled</h2>
            </div>
            <div className="panel-body">
              <p className="subtle">
                Every assumption a committee makes is stored with the annual period it was made from. Run{" "}
                <code>npm run check-memory</code> after <code>npm run ingest-edgar</code>: any assumption whose metric
                now has a newer period is marked held or broke by comparing the new figure with its rule. The record
                of which models&apos; assumptions held is on <Link href="/ai">Models &amp; Performance</Link>.
              </p>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
