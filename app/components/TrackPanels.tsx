import Link from "next/link";
import { RATING_LABEL, type DecisionRating } from "@/lib/decision/rating";
import { planCheckData, readTrackRecord, recordedCalls } from "@/lib/track/data";
import type { PlanCheck, PlanGroup } from "@/lib/track/plan-check";
import { RECORD_RULES, trackRecord, type CallView, type GroupStat, type RateVerdict, type TrackRecord } from "@/lib/track/record";
import { flatBand, type Outcome } from "@/lib/track/settle";

const RATING_TONE: Record<DecisionRating, string> = { buy: "good", overweight: "good", hold: "info", underweight: "bad", sell: "bad" };
const VERDICT_TONE: Record<Outcome["verdict"], string> = { right: "good", wrong: "bad", flat: "info", no_claim: "", excluded: "warn" };
const VERDICT_WORD: Record<Outcome["verdict"], string> = { right: "right", wrong: "wrong", flat: "too close to call", no_claim: "measured", excluded: "not measured" };

const pct = (n: number | null, digits = 1) => (n === null ? "—" : `${n >= 0 ? "+" : "−"}${Math.abs(n * 100).toFixed(digits)}%`);
const share = (n: number | null) => (n === null ? "—" : `${(n * 100).toFixed(0)}%`);
const rmult = (n: number | null) => (n === null ? "—" : `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(2)}R`);

/* ---------------------------------------------------------------- the calls */

function OutcomeChip({ o }: { o: Outcome }) {
  return (
    <span
      className={["pill", VERDICT_TONE[o.verdict]].filter(Boolean).join(" ")}
      title={o.verdict === "excluded" ? (o.reason ?? undefined) : `a move within ±${(flatBand(o.horizon) * 100).toFixed(1)}% of the market over ${o.horizon} sessions counts as too close to call`}
    >
      {o.horizon} sessions: {VERDICT_WORD[o.verdict]}
      {o.alpha !== null ? ` (${pct(o.alpha)})` : ""}
    </span>
  );
}

// Every recorded decision with what it did against the market and the sentences
// the stored record supports. Pure over the calls.
export function CallList({ calls }: { calls: CallView[] }) {
  return (
    <ul className="stack-sm">
      {calls.map((c) => (
        <li key={c.id}>
          <p>
            <Link href={`/research/${c.ticker}`}>
              <strong>{c.ticker}</strong>
            </Link>{" "}
            <span className={`pill ${RATING_TONE[c.rating]}`}>{RATING_LABEL[c.rating]}</span> <span className="subtle">{c.asOf ?? c.createdAt.slice(0, 10)}</span>{" "}
            {c.outcomes.map((o) => (
              <span key={o.horizon}>
                <OutcomeChip o={o} />{" "}
              </span>
            ))}
            {c.waiting.length > 0 && <span className="subtle">waiting on {c.waiting.map((h) => `${h}`).join(", ")} sessions</span>}
          </p>
          {c.headline && <p className="subtle">{c.headline}</p>}
          <details>
            <summary className="subtle">What the record shows</summary>
            <ul>
              {c.reflection.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
          </details>
        </li>
      ))}
    </ul>
  );
}

/* --------------------------------------------------------------- the record */

const VERDICT_NOTE: Record<Exclude<RateVerdict, "not_enough">, { tone: string; text: string }> = {
  better: { tone: "good", text: "better than a coin toss" },
  worse: { tone: "bad", text: "worse than a coin toss" },
  no_different: { tone: "info", text: "not distinguishable from a coin toss" },
};

function GroupRow({ horizon, label, g }: { horizon: number; label: string; g: GroupStat }) {
  const verdict =
    g.verdict === "not_enough" ? (
      <span className="subtle">{g.n === 0 ? "nothing measured yet" : `needs ${Math.max(0, RECORD_RULES.minDecided - g.decided)} more decided calls`}</span>
    ) : (
      <span className={`pill ${VERDICT_NOTE[g.verdict].tone}`}>{VERDICT_NOTE[g.verdict].text}</span>
    );
  return (
    <tr>
      <td>{horizon} sessions</td>
      <td>{label}</td>
      <td className="num">{g.n}</td>
      <td className="num">
        {g.right} / {g.wrong} / {g.flat}
      </td>
      <td className="num">{g.hitRate === null ? "—" : `${share(g.hitRate)} (${share(g.interval?.[0] ?? null)}–${share(g.interval?.[1] ?? null)})`}</td>
      <td className="num">{pct(g.meanEdge)}</td>
      <td>{verdict}</td>
    </tr>
  );
}

function PlanRows({ record }: { record: TrackRecord }) {
  const rows = record.plan.filter((p) => p.entries > 0);
  if (rows.length === 0) return null;
  return (
    <>
      <h3>How the plans&rsquo; stops and reward levels fared</h3>
      <table>
        <thead>
          <tr>
            <th>Horizon</th>
            <th className="num">Entries</th>
            <th className="num">Filled</th>
            <th className="num">Stopped</th>
            {rows[0].reached.map((r) => (
              <th key={r.multiple} className="num">
                Reached {r.multiple}R first
              </th>
            ))}
            <th className="num">Mean result</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.horizon}>
              <td>{p.horizon} sessions</td>
              <td className="num">{p.entries}</td>
              <td className="num">{p.filled}</td>
              <td className="num">{p.filled === 0 ? "—" : share(p.stopped / p.filled)}</td>
              {p.reached.map((r) => (
                <td key={r.multiple} className="num">
                  {p.filled === 0 ? "—" : share(r.count / p.filled)}
                </td>
              ))}
              <td className="num">{rmult(p.meanR)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

// How the person's recorded decisions have turned out. Pure over the record, so
// it renders without a database.
export function TrackRecordView({ record }: { record: TrackRecord }) {
  if (record.decisions === 0) {
    return (
      <section className="panel" id="track">
        <div className="panel-head">
          <h2>Track record</h2>
        </div>
        <p className="missing" style={{ padding: "0.9rem" }}>
          No decision has been recorded yet. Convene a committee, record the decision on its report, and the desk measures it against the S&amp;P 500 5, 20 and 60 sessions later.
        </p>
      </section>
    );
  }

  const withGroups = record.horizons.flatMap((h) => [
    { horizon: h.horizon, label: "Buy / Overweight", g: h.bullish },
    { horizon: h.horizon, label: "Underweight / Sell", g: h.bearish },
  ]);

  return (
    <section className="panel" id="track">
      <div className="panel-head">
        <h2>Track record</h2>
        <span className="hint">against the S&amp;P 500 · stored closes only · no model</span>
      </div>
      <div className="panel-body stack-sm">
        <p>
          <span className="pill info">{record.decisions} decisions</span> <span className="pill good">{record.withOutcome} measured at least once</span>{" "}
          <span className="pill">{record.awaiting} still waiting for their first horizon</span>
          {record.excluded > 0 && <span className="pill warn"> {record.excluded} not fairly measurable</span>}
        </p>

        <table>
          <thead>
            <tr>
              <th>Horizon</th>
              <th>Rating</th>
              <th className="num">Graded</th>
              <th className="num">Right / wrong / flat</th>
              <th className="num">Hit rate (95%)</th>
              <th className="num">Mean edge</th>
              <th>Against a coin toss</th>
            </tr>
          </thead>
          <tbody>
            {withGroups.map((row) => (
              <GroupRow key={`${row.horizon}|${row.label}`} {...row} />
            ))}
          </tbody>
        </table>
        <p className="subtle">
          A Buy or Overweight is right when the stock beat the market and an Underweight or Sell when it trailed it, past a band that widens with the horizon
          ({record.horizons.map((h) => `±${(flatBand(h.horizon) * 100).toFixed(1)}% at ${h.horizon}`).join(", ")}); inside it the call is flat and counts for
          neither side. The hit rate is right out of right plus wrong. Mean edge is the return less the market&rsquo;s, signed by the call, so positive means
          following the rating paid.{" "}
          {record.horizons[0].hold.n + record.horizons[1].hold.n + record.horizons[2].hold.n > 0 &&
            "Holds make no call against the market and are measured but not graded."}
        </p>

        <PlanRows record={record} />

        {record.calls.length > 0 && (
          <>
            <h3>The calls</h3>
            <CallList calls={record.calls} />
          </>
        )}

        <p className="subtle">
          A coin toss is what a rating with no skill would score against the market, and a comparison is declined until a group has {RECORD_RULES.minDecided} decided
          calls. The intervals assume each call is independent; calls made in the same weeks, in the same sectors and in one kind of market are not, so they are
          narrower than they should be, and a record made in a rising market says little about a falling one. It describes the past; it is not a forecast.
        </p>
      </div>
    </section>
  );
}

export async function TrackRecordPanel({ userId }: { userId: string }) {
  let record;
  try {
    record = await readTrackRecord(userId);
  } catch (err) {
    return (
      <section className="panel" id="track">
        <div className="panel-head">
          <h2>Track record</h2>
        </div>
        <p className="missing" style={{ padding: "0.9rem" }}>
          The track record could not be read: {err instanceof Error ? err.message : "unknown error"}.
        </p>
      </section>
    );
  }
  return <TrackRecordView record={record} />;
}

/* ------------------------------------------------------------- one stock */

// The person's earlier calls on one stock, for its research page.
export function StockTrackView({ ticker, calls }: { ticker: string; calls: CallView[] }) {
  return (
    <section className="panel" id="track">
      <div className="panel-head">
        <h2>Your earlier calls</h2>
        <span className="hint">{ticker} · measured against the S&amp;P 500</span>
      </div>
      <div className="panel-body stack-sm">
        {calls.length === 0 ? (
          <p className="missing">
            No decision recorded on {ticker} yet. Record one from a committee report and the desk measures it 5, 20 and 60 sessions later.
          </p>
        ) : (
          <>
            <CallList calls={calls} />
            <p className="subtle">
              The committee sees the figures from calls that have been measured. <Link href="/track">The whole track record</Link>.
            </p>
          </>
        )}
      </div>
    </section>
  );
}

export async function StockTrackPanel({ userId, ticker }: { userId: string; ticker: string }) {
  let calls;
  try {
    calls = trackRecord(await recordedCalls(userId, { ticker }), { listed: 5 }).calls;
  } catch (err) {
    return (
      <section className="panel" id="track">
        <div className="panel-head">
          <h2>Your earlier calls</h2>
        </div>
        <p className="missing" style={{ padding: "0.9rem" }}>
          Earlier calls could not be read: {err instanceof Error ? err.message : "unknown error"}.
        </p>
      </section>
    );
  }
  return <StockTrackView ticker={ticker} calls={calls} />;
}

/* ------------------------------------------------------------ the plan check */

function PlanGroupRow({ name, g }: { name: string; g: PlanGroup }) {
  if (g.entries === 0) return null;
  const of = (n: number) => (g.filled === 0 ? "—" : share(n / g.filled));
  return (
    <tr>
      <td>{name}</td>
      <td className="num">{g.entries}</td>
      <td className="num">{g.filled}</td>
      <td className="num">{of(g.stopped)}</td>
      {g.reached.map((r) => (
        <td key={r.multiple} className="num">
          {of(r.count)}
        </td>
      ))}
      <td className="num">{rmult(g.meanR)}</td>
      <td className="num">{rmult(g.meanHoldR)}</td>
    </tr>
  );
}

// The stop and reward arithmetic walked through stored price history. Pure over
// the check, so it renders without a database.
export function PlanCheckView({ check }: { check: PlanCheck }) {
  if (check.status === "unmeasured") {
    return (
      <section className="panel" id="plan-check">
        <div className="panel-head">
          <h2>Do the plan&rsquo;s stops and reward levels hold up?</h2>
        </div>
        <p className="missing" style={{ padding: "0.9rem" }}>
          {check.reason}
        </p>
      </section>
    );
  }

  return (
    <section className="panel" id="plan-check">
      <div className="panel-head">
        <h2>Do the plan&rsquo;s stops and reward levels hold up?</h2>
        <span className="hint">stored price history · no committee, no model</span>
      </div>
      <div className="panel-body stack-sm">
        <p>
          <span className="pill info">{check.all.entries} plans</span> <span className="pill">{check.tickers} stocks</span>{" "}
          <span className="pill">
            {check.from} to {check.to}
          </span>{" "}
          <span className="pill">stop {check.stopAtrs} ATRs, about {share(check.medianRiskShare)} of the price</span>
        </p>
        <p>
          Every {check.horizon} sessions on each stock, the plan the Trader would have drawn that day (the same arithmetic as on a committee report) is walked
          through the next {check.horizon} sessions. A stop that is touched in most plans is a stop that says &ldquo;the market breathed&rdquo;; a reward level that is
          rarely reached before the stop is one the risk is not repaid at.
        </p>

        <table>
          <thead>
            <tr>
              <th>Entries</th>
              <th className="num">Plans</th>
              <th className="num">Filled</th>
              <th className="num">Stopped</th>
              {check.rewardMultiples.map((m) => (
                <th key={m} className="num">
                  Reached {m}R first
                </th>
              ))}
              <th className="num">Mean, with the stop</th>
              <th className="num">Mean, without it</th>
            </tr>
          </thead>
          <tbody>
            <PlanGroupRow name="All" g={check.all} />
            <PlanGroupRow name="At the last close" g={check.market} />
            <PlanGroupRow name="Waiting for a pullback" g={check.pullback} />
          </tbody>
        </table>

        {!check.enough && <p className="subtle">Fewer than 30 plans: read these as an illustration, not a measurement.</p>}
        <p className="subtle">
          R is the risk the plan took: 1R is the distance from the entry to the stop. Where a session&rsquo;s range touched both the stop and a reward level, the
          order within the day is unknown and the stop is counted. A pullback entry fills only if a session trades down to it. Entries are spaced a window apart so
          none overlaps the next on the same stock, but stocks move together, so these are fewer independent observations than they look. It describes the past on
          these stocks; it is not a forecast.
        </p>
      </div>
    </section>
  );
}

export async function PlanCheckPanel() {
  let check;
  try {
    check = await planCheckData();
  } catch (err) {
    return (
      <section className="panel" id="plan-check">
        <div className="panel-head">
          <h2>Do the plan&rsquo;s stops and reward levels hold up?</h2>
        </div>
        <p className="missing" style={{ padding: "0.9rem" }}>
          The plan check could not be read: {err instanceof Error ? err.message : "unknown error"}.
        </p>
      </section>
    );
  }
  return <PlanCheckView check={check} />;
}
