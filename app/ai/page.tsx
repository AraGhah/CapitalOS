import {
  MIN_GRADED_RUNS,
  availableModels,
  listRegistry,
  rankForStage,
  stageRecords,
  type Stage,
} from "@/lib/ai/models";
import { modelPerformance, spendToday } from "@/lib/ai/store";
import { memoryRecordByModel } from "@/lib/ai/memory";
import { Meter } from "@/app/components/Readouts";

export const dynamic = "force-dynamic";

const STAGES: Array<{ id: Stage; label: string }> = [
  { id: "analyst", label: "Independent analysis" },
  { id: "specialist", label: "Specialist seats" },
  { id: "bull", label: "Bull advocate" },
  { id: "bear", label: "Bear advocate" },
  { id: "challenger", label: "Challenger" },
  { id: "fact_check", label: "Fact checker" },
  { id: "judge", label: "Judge" },
  { id: "synthesizer", label: "Synthesizer" },
];

export default async function AiPage() {
  const registry = listRegistry();
  const models = availableModels();
  const [records, performance, spend, memory] = await Promise.all([
    stageRecords(),
    modelPerformance(),
    spendToday(),
    memoryRecordByModel(),
  ]);
  const labelOf = new Map(registry.map((m) => [m.id, m.label]));
  const budget = Number(process.env.DAILY_CONSENSUS_BUDGET ?? 12);

  return (
    <div>
      <div className="page-head">
        <div>
          <p className="eyebrow">AI · models, routing and their record</p>
          <h1>Models &amp; Performance</h1>
        </div>
      </div>

      <div className="tiles" style={{ marginBottom: "1rem" }}>
        <div className="tile">
          <span className="label">Models seated</span>
          <div className="value">
            {models.length}
            <span style={{ color: "var(--faint)" }}>/{registry.length}</span>
          </div>
          <div className="foot">keys present in .env.local</div>
        </div>
        <div className="tile">
          <span className="label">Committees today</span>
          <div className="value">
            {spend.runs}
            <span style={{ color: "var(--faint)" }}>/{budget}</span>
          </div>
          <div className="foot">DAILY_CONSENSUS_BUDGET</div>
        </div>
        <div className="tile">
          <span className="label">Tokens today</span>
          <div className="value">{spend.tokens.toLocaleString()}</div>
          <div className="foot">including cache reads</div>
        </div>
        <div className="tile">
          <span className="label">Spend today</span>
          <div className="value">{spend.costUsd === null ? "—" : `$${spend.costUsd.toFixed(2)}`}</div>
          <div className="foot">{spend.costUsd === null ? "set prices in models.json" : "priced calls only"}</div>
        </div>
      </div>

      <div className="stack">
        <section className="panel">
          <div className="panel-head">
            <h2>Registry</h2>
            <span className="hint">edit models.json to add a provider or model — no rebuild needed</span>
          </div>
          <div className="panel-scroll">
            <table>
              <thead>
                <tr>
                  <th>Model</th>
                  <th>Provider</th>
                  <th>Tier</th>
                  <th className="wide">Model id</th>
                  <th>Status</th>
                  <th>Priced</th>
                </tr>
              </thead>
              <tbody>
                {registry.map((m) => (
                  <tr key={m.id}>
                    <td>{m.label}</td>
                    <td>{m.provider}</td>
                    <td>{m.tier}</td>
                    <td className="wide">
                      <code>{m.model ?? "—"}</code>
                    </td>
                    <td>
                      {m.available ? (
                        <span className="pill good">seated</span>
                      ) : (
                        <span className="pill" title="set this in .env.local">
                          needs {m.missing}
                        </span>
                      )}
                    </td>
                    <td>{m.priced ? "yes" : <span className="subtle">tokens only</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>Routing</h2>
            <span className="hint">
              which model each job goes to now — by track record after {MIN_GRADED_RUNS} graded runs, by tier before
            </span>
          </div>
          {models.length === 0 ? (
            <p className="missing" style={{ padding: "0.9rem" }}>
              No model seated.
            </p>
          ) : (
            <div className="panel-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Job</th>
                    <th>First choice</th>
                    <th className="wide">Then</th>
                    <th>Chosen by</th>
                  </tr>
                </thead>
                <tbody>
                  {STAGES.map((stage) => {
                    const ranked = rankForStage(stage.id, models, records);
                    const record = records.find((r) => r.stage === stage.id && r.modelId === ranked[0].id);
                    const byRecord = record !== undefined && record.runs >= MIN_GRADED_RUNS;
                    return (
                      <tr key={stage.id}>
                        <td>{stage.label}</td>
                        <td>{ranked[0].label}</td>
                        <td className="wide subtle">{ranked.slice(1).map((m) => m.label).join(" → ") || "—"}</td>
                        <td>
                          {byRecord ? (
                            <span className="pill info">
                              record {(record.overall * 100).toFixed(0)} over {record.runs}
                            </span>
                          ) : (
                            <span className="pill">tier default</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>Performance by model and job</h2>
            <span className="hint">accuracy from the fact checker, the rest from the judge</span>
          </div>
          {performance.length === 0 ? (
            <p className="missing" style={{ padding: "0.9rem" }}>
              No committee has sat yet — the record starts with the first run.
            </p>
          ) : (
            <div className="panel-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Model</th>
                    <th>Job</th>
                    <th>Calls</th>
                    <th>Failed</th>
                    <th>Accuracy</th>
                    <th>Overall</th>
                    <th></th>
                    <th>Avg latency</th>
                    <th>Tokens</th>
                    <th>Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {performance.map((p) => (
                    <tr key={`${p.modelId}-${p.stage}`}>
                      <td>{labelOf.get(p.modelId) ?? p.modelId}</td>
                      <td>{p.stage.replace("_", " ")}</td>
                      <td className="num">{p.calls}</td>
                      <td className={`num ${p.failures ? "down" : ""}`}>{p.failures}</td>
                      <td className="num">
                        {p.criteria.accuracy === undefined ? "—" : `${Math.round(p.criteria.accuracy * 100)}%`}
                      </td>
                      <td className="num">{p.overall === null ? "—" : (p.overall * 100).toFixed(0)}</td>
                      <td>{p.overall !== null && <Meter share={p.overall} />}</td>
                      <td className="num">{(p.avgLatencyMs / 1000).toFixed(1)}s</td>
                      <td className="num">{(p.inputTokens + p.outputTokens + p.cachedTokens).toLocaleString()}</td>
                      <td className="num">{p.costUsd === null ? "—" : `$${p.costUsd.toFixed(3)}`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>Assumptions that held</h2>
            <span className="hint">settled by later filings, never by a model</span>
          </div>
          {memory.length === 0 ? (
            <p className="missing" style={{ padding: "0.9rem" }}>
              Nothing settled yet. Assumptions are checked with <code>npm run check-memory</code> once a newer annual
              filing is ingested.
            </p>
          ) : (
            <div className="panel-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Model</th>
                    <th>Held</th>
                    <th>Broke</th>
                    <th>Waiting</th>
                    <th>Hit rate</th>
                  </tr>
                </thead>
                <tbody>
                  {memory.map((m) => {
                    const settled = m.supported + m.refuted;
                    return (
                      <tr key={m.modelId}>
                        <td>{labelOf.get(m.modelId) ?? m.modelId}</td>
                        <td className="num up">{m.supported}</td>
                        <td className="num down">{m.refuted}</td>
                        <td className="num">{m.pending}</td>
                        <td className="num">{settled === 0 ? "—" : `${Math.round((m.supported / settled) * 100)}%`}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
