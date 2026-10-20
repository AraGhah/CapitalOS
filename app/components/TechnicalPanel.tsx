import { technicalRead } from "@/lib/technical-read";
import type { TechnicalSnapshot } from "@/lib/technicals";

const level = (n: number | null) => (n === null ? "—" : n.toFixed(2));
const pct = (n: number | null) => (n === null ? "—" : `${n >= 0 ? "+" : ""}${(n * 100).toFixed(1)}%`);

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

const crossText = (c: TechnicalSnapshot["smaCross"]) =>
  c ? `${c.kind} cross ${c.sessionsAgo === 0 ? "on the last session" : `${c.sessionsAgo} sessions ago`}` : "none recently";

// The indicators the committee reads, computed by code from the same daily
// bars. Rendered inside Suspense: it may ask the market-data provider for a year
// of bars and the rest of the page should not wait for it.
export async function TechnicalPanel({ ticker }: { ticker: string }) {
  let read;
  try {
    read = await technicalRead(ticker);
  } catch (err) {
    return (
      <section className="panel">
        <div className="panel-head">
          <h2>Technicals</h2>
        </div>
        <p className="missing" style={{ padding: "0.9rem" }}>
          The indicators could not be computed: {err instanceof Error ? err.message : "unknown error"}.
        </p>
      </section>
    );
  }

  const s = read.snapshot;
  if (!s) {
    return (
      <section className="panel">
        <div className="panel-head">
          <h2>Technicals</h2>
        </div>
        <p className="missing" style={{ padding: "0.9rem" }}>
          Not enough price history to compute indicators — run <code>npm run fetch-prices</code>.
        </p>
      </section>
    );
  }

  const { readings: r } = s;
  const tone = (good: boolean | null) => (good === null ? "" : good ? "good" : "bad");

  return (
    <section className="panel" id="technicals">
      <div className="panel-head">
        <h2>Technicals</h2>
        <span className="hint">
          as of {s.asOf} · {s.sessions} sessions
        </span>
      </div>
      <div className="panel-body stack-sm">
        <p>
          {r.trend && <span className={`pill ${r.trend === "mixed" ? "info" : tone(r.trend === "uptrend")}`}>{r.trend}</span>}{" "}
          {r.rsiZone && <span className={`pill ${r.rsiZone === "neutral" ? "" : "warn"}`}>RSI {r.rsiZone}</span>}{" "}
          {r.macdMomentum && <span className={`pill ${tone(r.macdMomentum === "bullish")}`}>MACD {r.macdMomentum}</span>}
        </p>
        <table>
          <tbody>
            <Row label="10-day EMA" value={level(s.ema10)} />
            <Row label="50-day SMA" value={level(s.sma50)} note={`close ${pct(s.vsSma50)}`} />
            <Row label="200-day SMA" value={level(s.sma200)} note={`close ${pct(s.vsSma200)}`} />
            <Row label="RSI(14)" value={s.rsi14 === null ? "—" : s.rsi14.toFixed(1)} />
            <Row
              label="MACD(12,26,9)"
              value={s.macd ? level(s.macd.line) : "—"}
              note={s.macd ? `signal ${level(s.macd.signal)} · histogram ${level(s.macd.histogram)}${r.macdSlope ? ` ${r.macdSlope}` : ""}` : undefined}
            />
            <Row
              label="Bollinger(20,2)"
              value={s.bollinger ? `${level(s.bollinger.lower)} – ${level(s.bollinger.upper)}` : "—"}
              note={r.bandPosition ?? undefined}
            />
            <Row label="ATR(14)" value={level(s.atr14)} note={s.atrPct === null ? undefined : `${(s.atrPct * 100).toFixed(1)}% of price`} />
            <Row label="VWMA(20)" value={level(s.vwma20)} />
            <Row label="Volume vs prior 20 sessions" value={s.volumeRatio === null ? "—" : `${s.volumeRatio.toFixed(2)}x`} />
            <Row label="50/200-day cross" value={crossText(s.smaCross)} />
            <Row label="MACD cross" value={crossText(s.macdCross)} />
          </tbody>
        </table>
        <p className="subtle">
          Computed by code from {read.ref}. Conventional thresholds, not predictions; the committee reads these same
          figures as evidence.
        </p>
      </div>
    </section>
  );
}
