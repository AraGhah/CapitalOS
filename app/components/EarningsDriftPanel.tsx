import { earningsRead } from "@/lib/earnings/data";
import { DRIFT_RULES, type DriftRead, type Move, type Setup, type SurpriseKind } from "@/lib/earnings/drift";

const SURPRISE_TONE: Record<SurpriseKind, string> = { beat: "good", miss: "bad", "in line": "info", unscaled: "" };
const MOVE_TONE: Record<Move, string> = { up: "good", down: "bad", flat: "info" };
const SETUP_TONE: Record<Setup, string> = { confirmed: "good", unconfirmed: "warn", none: "", unmeasured: "" };
const SETUP_LABEL: Record<Setup, string> = {
  confirmed: "market confirmed it",
  unconfirmed: "market did not confirm it",
  none: "no surprise to confirm",
  unmeasured: "reaction not measured",
};

const eps = (n: number) => `${n < 0 ? "−" : ""}${Math.abs(n).toFixed(2)}`;
const sue = (n: number | null) => (n === null ? "—" : `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(1)}`);
const pct = (n: number | null) => (n === null ? "—" : `${n >= 0 ? "+" : "−"}${Math.abs(n * 100).toFixed(1)}%`);

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

// The latest quarter's earnings surprise, how the stock reacted and what it has
// done since. Pure over the read, so it renders without a database.
export function EarningsDriftView({ drift, source }: { drift: DriftRead; source: string | null }) {
  const { latest, announcement, reaction, reading } = drift;

  if (drift.status === "unmeasured" || !latest || !reading) {
    return (
      <section className="panel" id="earnings">
        <div className="panel-head">
          <h2>Earnings drift</h2>
        </div>
        <p className="missing" style={{ padding: "0.9rem" }}>
          {drift.reason ?? "The earnings surprise could not be measured."}
        </p>
      </section>
    );
  }

  return (
    <section className="panel" id="earnings">
      <div className="panel-head">
        <h2>Earnings drift</h2>
        <span className="hint">quarter ended {latest.periodEnd}</span>
      </div>
      <div className="panel-body stack-sm">
        <p>
          <span className={`pill ${SURPRISE_TONE[reading.surprise]}`}>{reading.surprise}</span>{" "}
          {reading.move && <span className={`pill ${MOVE_TONE[reading.move]}`}>stock {reading.move}</span>}{" "}
          <span className={`pill ${SETUP_TONE[reading.setup]}`}>{SETUP_LABEL[reading.setup]}</span>
        </p>
        <p>{reading.summary}</p>
        <table>
          <tbody>
            <Row label="Diluted EPS" value={eps(latest.eps)} note={`${eps(latest.yearAgo)} a year earlier`} />
            <Row
              label="Standardised surprise (SUE)"
              value={sue(latest.sue)}
              note={
                latest.deviation === null
                  ? `needs ${DRIFT_RULES.minHistory} earlier quarters, has ${latest.history}`
                  : `change ${eps(latest.change)} against a usual spread of ${latest.deviation.toFixed(2)} over ${latest.history} quarters`
              }
            />
            {announcement && (
              <Row
                label="Announced"
                value={announcement.on}
                note={announcement.dating === "release" ? "from the 8-K, Item 2.02" : "from the periodic filing, which can be weeks late"}
              />
            )}
            {reaction && (
              <>
                <Row
                  label="Reaction"
                  value={pct(reaction.abnormal)}
                  note={reaction.adjusted ? `stock ${pct(reaction.stock)} against market ${pct(reaction.market)}` : `stock ${pct(reaction.stock)}, not adjusted for the market`}
                />
                <Row
                  label="Drift since"
                  value={pct(reaction.drift)}
                  note={`${reaction.sessionsSince} sessions of the ${DRIFT_RULES.window}-session window`}
                />
              </>
            )}
          </tbody>
        </table>

        {drift.reactionNote && <p className="subtle">{drift.reactionNote}</p>}
        {drift.newerReport && <p className="subtle">{drift.newerReport}</p>}

        {drift.quarters.length > 1 && (
          <table>
            <thead>
              <tr>
                <th>Quarter</th>
                <th className="num">EPS</th>
                <th className="num">Year ago</th>
                <th className="num">SUE</th>
              </tr>
            </thead>
            <tbody>
              {[...drift.quarters].reverse().map((q) => (
                <tr key={q.accession}>
                  <td>{q.periodEnd}</td>
                  <td className="num">{eps(q.eps)}</td>
                  <td className="num">{eps(q.yearAgo)}</td>
                  <td className="num">{sue(q.sue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <p className="subtle">
          Computed by code{source ? ` from ${source}` : ""}, no analyst estimates and no model: the change in earnings per share from a year earlier,
          measured against how much that change has varied. Post-earnings-announcement drift is a historical tendency that has weakened as it
          became known, not a forecast. The committee reads these same figures as evidence.
        </p>
      </div>
    </section>
  );
}

// Rendered inside Suspense: it may ask the market-data provider for a year of
// bars of the stock and of the market.
export async function EarningsDriftPanel({ company }: { company: { id: string; ticker: string } }) {
  let read;
  try {
    read = await earningsRead(company);
  } catch (err) {
    return (
      <section className="panel" id="earnings">
        <div className="panel-head">
          <h2>Earnings drift</h2>
        </div>
        <p className="missing" style={{ padding: "0.9rem" }}>
          The earnings drift could not be read: {err instanceof Error ? err.message : "unknown error"}.
        </p>
      </section>
    );
  }
  return <EarningsDriftView drift={read.drift} source={read.ref} />;
}
