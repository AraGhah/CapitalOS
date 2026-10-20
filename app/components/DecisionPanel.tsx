import Link from "next/link";
import type { Actor } from "@/lib/actor";
import { decideForRun } from "@/lib/decision/data";
import { ACTION_LABEL, type Action, type Decision } from "@/lib/decision/decide";
import { PLAN_RULES } from "@/lib/decision/plan";
import { RATINGS, RATING_LABEL, RATING_MEANING, RATING_RULES, WEIGHTS, type DecisionRating } from "@/lib/decision/rating";
import { SEAT_LABEL, SEAT_RULES, type RiskDebate, type SeatTest, type Stance } from "@/lib/decision/risk-debate";
import { listDecisions, type RecordedDecision } from "@/lib/decision/store";
import { RecordDecision } from "@/app/components/RecordDecision";

const ACTION_TONE: Record<Action, string> = { buy: "good", add: "good", hold: "info", watch: "info", trim: "warn", sell: "bad", avoid: "bad" };
const RATING_TONE: Record<DecisionRating, string> = { buy: "up", overweight: "up", hold: "", underweight: "down", sell: "down" };
const STANCE_TONE: Record<Stance, string> = { approve: "good", reduce: "warn", reject: "bad" };
const STANCE_LABEL: Record<Stance, string> = { approve: "Approves", reduce: "Reduces", reject: "Rejects" };

const num = (n: number, digits = 2) => n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const whole = (n: number) => Math.round(n).toLocaleString("en-US");
const pct = (n: number, digits = 1) => `${(n * 100).toFixed(digits)}%`;
const signed = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(2)}`;

function Row({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <tr>
      <td className="wide" style={{ paddingLeft: 0 }}>
        {label}
        {note && <span className="subtle"> · {note}</span>}
      </td>
      <td className="num" style={{ paddingRight: 0 }}>
        {value}
      </td>
    </tr>
  );
}

function figure(t: SeatTest, which: "value" | "limit"): string {
  const x = which === "value" ? t.value : t.limit;
  if (x === null) return "not measured";
  switch (t.key) {
    case "bad_day":
      return pct(x, 2);
    case "market":
      return x.toFixed(2);
    case "overlap":
      return pct(x, 0);
    case "exit":
      return `${x.toFixed(which === "value" ? 1 : 0)} ${x === 1 ? "session" : "sessions"}`;
  }
}

const STATUS_WORD: Record<SeatTest["status"], string> = { within: "within", close: "close", over: "over", unmeasured: "" };

// The three risk seats: one column each, one row per test, the person's own seat lit.
function RiskDebateView({ debate, base }: { debate: RiskDebate; base: string }) {
  const rows = debate.seats[0].tests;
  return (
    <div>
      <h3>The risk debate</h3>
      <p>{debate.summary}</p>
      {debate.warnings.map((w, i) => (
        <p key={i} className="missing">
          {w}
        </p>
      ))}
      <div style={{ overflowX: "auto" }}>
        <table className="seat-table">
          <thead>
            <tr>
              <th scope="col">
                <span className="subtle">
                  {debate.window ? `${debate.window.sessions} shared sessions to ${debate.window.asOf}` : "not measured"}
                </span>
              </th>
              {debate.seats.map((s) => (
                <th key={s.seat} scope="col" className={s.seat === debate.deciding ? "deciding" : undefined}>
                  {SEAT_LABEL[s.seat]}
                  {s.seat === debate.deciding && " · yours"}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={row.key}>
                <th scope="row">{row.label}</th>
                {debate.seats.map((s) => {
                  const t = s.tests[i];
                  return (
                    <td key={s.seat} className={s.seat === debate.deciding ? "deciding" : undefined}>
                      <span className={`num ${t.status}`}>{figure(t, "value")}</span>
                      <span className="subtle">
                        {" "}
                        · bar {figure(t, "limit")}
                        {STATUS_WORD[t.status] && ` · ${STATUS_WORD[t.status]}`}
                      </span>
                    </td>
                  );
                })}
              </tr>
            ))}
            <tr>
              <th scope="row">Position</th>
              {debate.seats.map((s) => (
                <td key={s.seat} className={s.seat === debate.deciding ? "deciding" : undefined}>
                  <span className={`pill ${STANCE_TONE[s.stance]}`}>{STANCE_LABEL[s.stance]}</span>{" "}
                  <span className="num">
                    {whole(s.value)} {base}
                  </span>
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
      <div className="seat-notes">
        {debate.seats.map((s) => (
          <details key={s.seat} open={s.seat === debate.deciding} className="why-box">
            <summary>
              {SEAT_LABEL[s.seat]}: {s.verdict}
            </summary>
            {s.for.length > 0 && (
              <>
                <strong>For</strong>
                <ul>
                  {s.for.map((line, i) => (
                    <li key={i}>{line}</li>
                  ))}
                </ul>
              </>
            )}
            {s.against.length > 0 && (
              <>
                <strong>Against</strong>
                <ul>
                  {s.against.map((line, i) => (
                    <li key={i}>{line}</li>
                  ))}
                </ul>
              </>
            )}
          </details>
        ))}
      </div>
      <p className="subtle">
        The seat that matches your risk tolerance decides; the other two are the range around it. Each seat holds the same measured figures to its own bars (a bad
        day may add {pct(SEAT_RULES.conservative.badDay, 2)}, {pct(SEAT_RULES.neutral.badDay, 2)} or {pct(SEAT_RULES.aggressive.badDay, 2)} of your capital, for
        the conservative, neutral and aggressive seat), and a test the desk could not measure takes part of the addition off for the cautious seats rather than
        passing for free. Every bar is in <code>lib/decision/risk-debate.ts</code>.
      </p>
    </div>
  );
}

// The decision as a page section. Takes the decision rather than fetching it, so
// it renders the same from the database or from a test.
export function DecisionView({ decision, history, runId }: { decision: Decision; history: RecordedDecision[]; runId: string }) {
  const { rating, plan, sizing, currency } = decision;
  const base = currency.base;
  const unique = [...new Set(decision.cautions)];

  return (
    <section className="panel" id="decision">
      <div className="panel-head">
        <h2>Decision</h2>
        <span className="hint">computed by code from this committee, your checklist and your portfolio · no model called · {decision.asOf}</span>
      </div>
      <div className="panel-body stack-sm">
        <div className="ladder" role="img" aria-label={`Rating: ${RATING_LABEL[rating.final]}`}>
          {RATINGS.map((r) => (
            <span key={r} className={r === rating.final ? `on ${RATING_TONE[r]}`.trim() : undefined}>
              {RATING_LABEL[r]}
            </span>
          ))}
        </div>
        <p>
          <span className={`pill ${ACTION_TONE[decision.action]}`}>{ACTION_LABEL[decision.action]}</span> <strong>{decision.headline}</strong>
        </p>
        <p className="subtle">
          {RATING_LABEL[rating.final]} means: {RATING_MEANING[rating.final]}.
          {rating.final !== rating.raw && ` The committee's scores alone would have given ${RATING_LABEL[rating.raw]}.`}
        </p>

        {decision.blockers.map((b, i) => (
          <p key={i} className="alert">
            {b}
          </p>
        ))}

        <details className="why-box">
          <summary>How the rating was reached</summary>
          {rating.composite === null ? (
            <p className="missing">No dimension was scored.</p>
          ) : (
            <p>
              Weighted mean of the dimensions the committee resolved: <strong className="num">{signed(rating.composite)}</strong> on the −2…+2 scale
              ({pct(rating.weightShare, 0)} of the weight scored). Buy at {RATING_RULES.buy.toFixed(1)} or more, overweight at {RATING_RULES.overweight.toFixed(1)},
              underweight at {RATING_RULES.underweight.toFixed(1)} or less, sell at {RATING_RULES.sell.toFixed(1)} or less.
            </p>
          )}
          <table className="check-facts">
            <tbody>
              {rating.contributions.map((c) => (
                <Row
                  key={c.key}
                  label={c.label}
                  value={c.resolved === null ? "not scored" : signed(c.resolved)}
                  note={`weight ${WEIGHTS[c.key]}${c.contested ? " · contested" : ""}`}
                />
              ))}
            </tbody>
          </table>
          {rating.steps.length > 0 && (
            <ul>
              {rating.steps.map((s, i) => (
                <li key={i}>
                  <strong>
                    {RATING_LABEL[s.from]} → {RATING_LABEL[s.to]}
                  </strong>{" "}
                  ({s.rule}): {s.reason}
                </li>
              ))}
            </ul>
          )}
        </details>

        {plan.side === "enter" && plan.entry && (
          <div>
            <h3>The plan</h3>
            <table className="check-facts">
              <tbody>
                <Row label="Entry" value={`${num(plan.entry.price)} ${currency.listing}`} note={plan.entry.kind === "pullback" ? "on a pullback" : "about the last close"} />
                {plan.stop && <Row label="Stop" value={num(plan.stop.price)} note={plan.stop.note} />}
                {plan.riskPerShare !== null && plan.riskShare !== null && (
                  <Row label="Risked per share" value={num(plan.riskPerShare)} note={`${pct(plan.riskShare)} of the entry`} />
                )}
                {plan.levels.map((l) => (
                  <Row key={l.multiple} label={`Reward = ${l.multiple}× the risk`} value={num(l.price)} />
                ))}
              </tbody>
            </table>
            <p className="subtle">
              The stop is {PLAN_RULES.stopAtrs} average true ranges below the entry. The reward levels are what a win must reach to repay the risk, not a forecast
              of where the price will go: this desk&apos;s committee does not predict prices.
            </p>
          </div>
        )}

        {sizing.targetValue !== null && (
          <div>
            <h3>The size</h3>
            <table className="check-facts">
              <tbody>
                {sizing.capital !== null && <Row label="Your capital" value={`${whole(sizing.capital)} ${base}`} note="holdings plus the money you set aside to invest" />}
                {sizing.constraints.map((c) => (
                  <Row
                    key={c.name}
                    label={`Ceiling: ${c.name}${c.name === sizing.binding ? " (lowest)" : ""}`}
                    value={`${whole(c.limit)} ${base}`}
                    note={c.note}
                  />
                ))}
                {sizing.multipliers.map((m) => (
                  <Row key={m.name} label={`× ${m.factor}  ${m.name}`} value="" note={m.reason} />
                ))}
                {sizing.finalCap && (
                  <Row label={`Cut by the ${sizing.finalCap.name} to`} value={`${whole(sizing.finalCap.limit)} ${base}`} note="see the risk debate below" />
                )}
                <Row label="Position the plan asks for" value={`${whole(sizing.targetValue)} ${base}`} note={sizing.targetWeight !== null ? `${pct(sizing.targetWeight)} of your capital` : undefined} />
                <Row label="You hold now" value={`${whole(sizing.currentValue)} ${base}`} />
                {sizing.shares !== null && <Row label={sizing.shares < 0 ? "Shares to sell" : "Shares to buy"} value={String(Math.abs(sizing.shares))} />}
              </tbody>
            </table>
          </div>
        )}

        {decision.riskDebate && <RiskDebateView debate={decision.riskDebate} base={base} />}

        {unique.length > 0 && (
          <ul>
            {unique.map((c, i) => (
              <li key={i} className="subtle">
                {c}
              </li>
            ))}
          </ul>
        )}

        <p className="subtle">
          {decision.checklist ? (
            <>
              Your pre-investment checklist: {decision.checklist.headline}{" "}
              <Link href={`/research/${decision.ticker}#checklist`}>See the checklist</Link>.
            </>
          ) : (
            "The pre-investment checklist could not be built."
          )}
        </p>

        <RecordDecision runId={runId} />

        {history.length > 0 && (
          <div>
            <h3>Recorded decisions</h3>
            <ul>
              {history.map((h) => (
                <li key={h.id}>
                  <time dateTime={h.createdAt}>{h.createdAt.slice(0, 10)}</time>{" "}
                  <span className={`pill ${ACTION_TONE[h.action]}`}>{ACTION_LABEL[h.action]}</span> {RATING_LABEL[h.rating]}
                  {h.refPrice !== null && <span className="subtle"> · at {num(h.refPrice)}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}

        <p className="subtle">
          Rules applied to numbers the desk measured, not advice. Every threshold is in <code>lib/decision</code>.
        </p>
      </div>
    </section>
  );
}

// Rendered inside Suspense: it builds the whole checklist and reads a year of
// prices, and the committee report below should not wait for it.
export async function DecisionPanel({ actor, runId, ticker }: { actor: Pick<Actor, "userId" | "accountId">; runId: string; ticker: string }) {
  let loaded;
  try {
    const [{ decision }, history] = await Promise.all([decideForRun(actor, runId), listDecisions(actor.userId, { ticker, limit: 5 })]);
    loaded = { decision, history };
  } catch (err) {
    return (
      <section className="panel" id="decision">
        <div className="panel-head">
          <h2>Decision</h2>
        </div>
        <p className="missing" style={{ padding: "0.9rem" }}>
          The decision could not be worked out: {err instanceof Error ? err.message : "unknown error"}.
        </p>
      </section>
    );
  }
  return <DecisionView decision={loaded.decision} history={loaded.history} runId={runId} />;
}
