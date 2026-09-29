import Decimal from "decimal.js";
import Link from "next/link";
import { Suspense } from "react";
import { getPortfolio } from "@/lib/holdings";
import { getPortfolioSeries } from "@/lib/timeseries";
import { ACCOUNT_ID, BENCHMARK_TICKER } from "@/lib/constants";
import { listTheses } from "@/lib/theses";
import {
  getDeskSentiment,
  getDiscoveryFeeds,
  getFeedStatus,
  getPipeline,
  getTape,
  getWire,
} from "@/lib/desk";
import { getVerdicts } from "@/lib/dossier";
import { money, timeAgo } from "@/lib/format";
import { BenchmarkChart } from "./BenchmarkChart";
import { Sparkline } from "./components/Sparkline";
import { Pipeline } from "./components/Readouts";
import { FeedRail } from "./components/FeedRail";
import { Wire } from "./components/Wire";
import { listRuns } from "@/lib/ai/store";
import { listMemory } from "@/lib/ai/memory";
import { modeSpec } from "@/lib/ai/modes";
import { RiskBrief } from "./components/RiskBrief";
import { listAlerts } from "@/lib/autopilot/cycle";

export const dynamic = "force-dynamic";

export default async function DeskPage() {
  const [
    { holdings, totalReturn },
    series,
    theses,
    tape,
    feeds,
    stages,
    wire,
    discovery,
    deskSentiment,
    verdicts,
    committees,
    memory,
    openAlerts,
  ] = await Promise.all([
    getPortfolio(ACCOUNT_ID),
    getPortfolioSeries(ACCOUNT_ID),
    listTheses(),
    getTape(),
    getFeedStatus(),
    getPipeline(),
    getWire(12),
    getDiscoveryFeeds(),
    getDeskSentiment(),
    getVerdicts(),
    listRuns({ limit: 5 }),
    listMemory({ limit: 50 }),
    listAlerts({ status: "new", limit: 5 }),
  ]);
  const brokenMemory = memory.filter((m) => m.status === "refuted");

  const live = theses.filter((t) => t.thesis.status !== "closed");
  const broken = live.filter((t) => t.thesis.status === "invalidated" || t.breached);
  const totalMarketValue = holdings.reduce((sum, h) => sum.add(h.marketValue), new Decimal(0));
  const sparkByTicker = new Map(tape.map((t) => [t.ticker, t.spark]));

  const wireItems = wire.map((w) => ({
    id: w.id,
    title: w.title,
    url: w.url,
    ago: timeAgo(w.firstSeen),
    sourceCount: w.sourceCount,
    ticker: w.ticker,
  }));

  const last = series.at(-1);
  const vsBenchmark = last ? last.portfolioIndex - last.benchmarkIndex : null;

  return (
    <div>
      <div className="page-head">
        <div>
          <p className="eyebrow">Command Center</p>
          <h1>Portfolio</h1>
        </div>
        <Pipeline stages={stages} />
      </div>

      <div className="tiles" style={{ marginBottom: "1rem" }}>
        <div className="tile">
          <span className="label">Total value</span>
          <div className="value">{money(totalMarketValue.toNumber())}</div>
          <div className="foot">
            {holdings.length} {holdings.length === 1 ? "position" : "positions"}
          </div>
        </div>

        <div className="tile">
          <span className="label">Total return</span>
          <div className={`value ${totalReturn.gte(0) ? "up" : "down"}`}>
            {totalReturn.gte(0) ? "+" : ""}
            {totalReturn.mul(100).toFixed(2)}%
          </div>
          <div className="foot">cost basis to last close</div>
        </div>

        <div className="tile">
          <span className="label">vs {BENCHMARK_TICKER}</span>
          <div className={`value ${vsBenchmark === null ? "" : vsBenchmark >= 0 ? "up" : "down"}`}>
            {vsBenchmark === null ? "—" : `${vsBenchmark >= 0 ? "+" : ""}${vsBenchmark.toFixed(1)}`}
          </div>
          <div className="foot">index points, both from 100</div>
        </div>

        <div className="tile">
          <span className="label">Theses</span>
          <div className={`value ${broken.length > 0 ? "down" : ""}`}>
            {live.length - broken.length}
            <span style={{ color: "var(--faint)" }}>/{live.length}</span>
          </div>
          <div className="foot">still holding</div>
        </div>
      </div>

      {broken.length > 0 && (
        <div className="alert" style={{ marginBottom: "1rem" }}>
          <span className="dot" style={{ background: "currentColor" }} />
          {broken.length === 1
            ? "One thesis no longer holds — a rule it was opened on has been crossed."
            : `${broken.length} theses no longer hold — a rule each was opened on has been crossed.`}
        </div>
      )}

      {brokenMemory.length > 0 && (
        <div className="alert" style={{ marginBottom: "1rem" }}>
          <span className="dot" style={{ background: "currentColor" }} />
          <Link href="/journal">
            {brokenMemory.length === 1
              ? "A committee assumption was contradicted by a newer filing."
              : `${brokenMemory.length} committee assumptions were contradicted by newer filings.`}
          </Link>
        </div>
      )}

      <div className="split">
        <div className="stack">
          <section className="panel">
            <div className="panel-head">
              <h2>Portfolio against {BENCHMARK_TICKER}</h2>
              <span className="hint">both indexed to 100 at the first comparable date</span>
            </div>
            <div className="panel-body">
              <BenchmarkChart data={series} />
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>Positions</h2>
              <span className="hint">last 30 closes</span>
            </div>
            <div className="panel-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Ticker</th>
                    <th></th>
                    <th>Qty</th>
                    <th>Avg cost</th>
                    <th>Last</th>
                    <th>Value</th>
                    <th>Weight</th>
                    <th>Unrealized</th>
                    <th>Verdict</th>
                  </tr>
                </thead>
                <tbody>
                  {holdings.map((h) => {
                    const spark = sparkByTicker.get(h.ticker) ?? [];
                    return (
                      <tr key={h.companyId}>
                        <td>
                          <Link href={`/research/${h.ticker}`} className="sym">
                            {h.ticker}
                          </Link>
                        </td>
                        <td>
                          <Sparkline values={spark} />
                        </td>
                        <td className="num">{h.qty.toString()}</td>
                        <td className="num">{h.avgCost.toFixed(2)}</td>
                        <td className="num">{h.price.toFixed(2)}</td>
                        <td className="num">{money(h.marketValue.toNumber())}</td>
                        <td className="num">{h.weight.mul(100).toFixed(1)}%</td>
                        <td className={`num ${h.unrealizedPL.gte(0) ? "up" : "down"}`}>
                          {h.unrealizedPL.gte(0) ? "+" : "−"}
                          {money(h.unrealizedPL.abs().toNumber())}
                        </td>
                        <td>
                          {(() => {
                            const call = verdicts.get(h.ticker);
                            if (!call) return <span className="subtle">—</span>;
                            const tone =
                              call.verdict === "BUY" || call.verdict === "ACCUMULATE"
                                ? "good"
                                : call.verdict === "AVOID"
                                  ? "bad"
                                  : "";
                            return <span className={`pill ${tone}`.trim()}>{call.verdict}</span>;
                          })()}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {holdings.length === 0 && (
              <p className="missing" style={{ padding: "0.9rem" }}>
                No open positions yet — add a transaction to get started.
              </p>
            )}
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>Theses</h2>
              <span className="hint">checked by rule, never by judgement</span>
            </div>
            {live.length === 0 ? (
              <p className="missing" style={{ padding: "0.9rem" }}>
                No open theses.
              </p>
            ) : (
              live.map(({ thesis, checks, breached, periodEnd }) => (
                <details key={thesis.id} open={breached}>
                  <summary>
                    <span>
                      <span className="sym">{thesis.ticker}</span>
                      {thesis.rationale && (
                        <span className="subtle" style={{ marginLeft: "0.6rem" }}>
                          {thesis.rationale}
                        </span>
                      )}
                    </span>
                    <span className={`pill ${breached ? "bad" : "good"}`}>
                      {breached ? "invalidated" : "holding"}
                    </span>
                  </summary>
                  <div className="panel-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>Rule</th>
                          <th>Latest{periodEnd ? ` (${periodEnd})` : ""}</th>
                          <th>Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {checks.map((check, i) => (
                          <tr key={i}>
                            <td className="wide">
                              {check.rule.metric} {check.rule.operator} {check.rule.value}
                            </td>
                            <td className="num">
                              {check.actual === null ? "—" : check.actual.toPrecision(4)}
                            </td>
                            <td>
                              {check.actual === null ? (
                                <span className="pill">not checked</span>
                              ) : (
                                <span className={`pill ${check.breached ? "bad" : "good"}`}>
                                  {check.breached ? "breached" : "holding"}
                                </span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              ))
            )}
          </section>
        </div>

        <div className="stack">
          {openAlerts.length > 0 && (
            <section className="panel">
              <div className="panel-head">
                <h2>Important alerts</h2>
                <Link href="/alerts" className="hint">
                  review →
                </Link>
              </div>
              <ul className="why panel-body">
                {openAlerts.map((a) => (
                  <li key={a.id}>
                    <span className={`pill ${a.severity === "high" ? "bad" : a.severity === "warn" ? "warn" : "info"}`}>
                      {a.severity}
                    </span>
                    <span>{a.title}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <Suspense fallback={null}>
            <RiskBrief />
          </Suspense>

          <section className="panel">
            <div className="panel-head">
              <h2>AI research activity</h2>
              <Link href="/committee" className="hint">
                convene →
              </Link>
            </div>
            {committees.length === 0 ? (
              <p className="missing" style={{ padding: "0.9rem" }}>
                No committee has sat yet.
              </p>
            ) : (
              <ul className="rail">
                {committees.map((r) => (
                  <li key={r.id}>
                    <span
                      className={r.status === "running" ? "dot" : "dot idle"}
                      style={r.status === "failed" ? { background: "var(--down)" } : r.status === "done" ? { background: "var(--up)" } : undefined}
                    />
                    <span className="feed-name" title={r.headline ?? r.error ?? undefined}>
                      <Link href={`/committee/${r.id}`}>
                        <span className="num">{r.ticker}</span> · {modeSpec(r.mode).label}
                      </Link>
                    </span>
                    <span className="count">
                      {r.confidence === null ? timeAgo(r.createdAt) : Math.round(r.confidence * 100)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {deskSentiment.tagged > 0 && (
            <section className="panel">
              <div className="panel-head">
                <h2>News sentiment</h2>
                <span className="hint">{deskSentiment.tagged} tagged</span>
              </div>
              <div className="panel-body">
                <div className="gauge">
                  <div
                    className="gauge-bar"
                    role="img"
                    aria-label={`sentiment ${deskSentiment.score.toFixed(0)} from -100 bearish to +100 bullish`}
                  >
                    <span
                      className="gauge-mark"
                      style={{ left: `${(deskSentiment.score + 100) / 2}%` }}
                    />
                  </div>
                  <div className="gauge-scale">
                    <span>bearish</span>
                    <span>bullish</span>
                  </div>
                </div>
                <div className="sentiment-counts">
                  <div>
                    <span className="n up">{deskSentiment.bullish}</span>
                    <span className="k">bullish</span>
                  </div>
                  <div>
                    <span className="n">{deskSentiment.neutral}</span>
                    <span className="k">neutral</span>
                  </div>
                  <div>
                    <span className="n down">{deskSentiment.bearish}</span>
                    <span className="k">bearish</span>
                  </div>
                </div>
              </div>
            </section>
          )}

          {discovery.length > 0 && (
            <section className="panel">
              <div className="panel-head">
                <h2>Discovery feeds</h2>
                <span className="hint">last run</span>
              </div>
              <ul className="rail">
                {discovery.map((feed) => (
                  <li key={feed.feed}>
                    <span
                      className="dot idle"
                      style={{
                        background: feed.error
                          ? "var(--down)"
                          : feed.storedHeadlines > 0
                            ? "var(--up)"
                            : "var(--faint)",
                      }}
                    />
                    <span className="feed-name" title={feed.error ?? undefined}>
                      {feed.label}
                    </span>
                    <span className={feed.error ? "count offline" : "count"}>
                      {feed.error ? "offline" : feed.storedHeadlines}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <FeedRail feeds={feeds} />

          <section className="panel">
            <div className="panel-head">
              <h2>The wire</h2>
              <span className="hint">by coverage</span>
            </div>
            <Wire items={wireItems} filterable={false} />
          </section>
        </div>
      </div>
    </div>
  );
}
