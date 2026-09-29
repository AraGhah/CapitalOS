import Link from "next/link";
import { analyzeRisk } from "@/lib/risk/engine";

const TONE: Record<string, string> = { high: "bad", warn: "warn", info: "info" };

// The Command Center's "what risks are developing?" — rendered inside Suspense,
// because it fetches a year of prices and the rest of the page should not wait.
export async function RiskBrief() {
  let report;
  try {
    report = await analyzeRisk({ kind: "holdings" });
  } catch {
    return null;
  }
  if (report.positions.length === 0) return null;

  const p = report.portfolio;
  const flagged = report.findings.filter((f) => f.severity !== "info").slice(0, 3);

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Risks developing</h2>
        <Link href="/risk" className="hint">
          risk →
        </Link>
      </div>
      <div className="panel-body stack-sm">
        <p className="subtle">
          Volatility {p.vol === null ? "—" : `${(p.vol * 100).toFixed(1)}%`} · beta{" "}
          {p.beta === null ? "—" : p.beta.toFixed(2)} · 1-day VaR{" "}
          {p.var95 === null ? "—" : `${(p.var95 * 100).toFixed(1)}%`}
        </p>
        {flagged.length === 0 ? (
          <p className="missing">No concentration or exposure threshold crossed.</p>
        ) : (
          <ul className="why">
            {flagged.map((f, i) => (
              <li key={i}>
                <span className={`pill ${TONE[f.severity]}`}>{f.severity}</span>
                <span>{f.text}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
