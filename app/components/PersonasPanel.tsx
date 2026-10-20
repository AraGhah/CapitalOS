import { lensRead } from "@/lib/personas/data";
import { FIT_LABEL, LENS_RULES, type CheckStatus, type Fit, type LensReport, type LensView } from "@/lib/personas/lenses";

const FIT_TONE: Record<Fit, string> = { fits: "good", mixed: "info", does_not_fit: "bad", unscored: "" };
const STATUS_TONE: Record<CheckStatus, string> = { pass: "good", partial: "warn", fail: "bad", missing: "" };
const STATUS_LABEL: Record<CheckStatus, string> = { pass: "Pass", partial: "Partly", fail: "Fail", missing: "No data" };

const share = (n: number) => `${Math.round(n * 100)}%`;

function Lens({ lens }: { lens: LensView }) {
  return (
    <details className="lens">
      <summary>
        <span>
          <strong>{lens.name}</strong> <span className="subtle">· {lens.school}</span>
        </span>
        <span>
          <span className={`pill ${FIT_TONE[lens.fit]}`}>{FIT_LABEL[lens.fit]}</span>
          {lens.score !== null && lens.fit !== "unscored" && <span className="subtle num"> {share(lens.score)}</span>}
        </span>
      </summary>
      <div className="lens-body stack-sm">
        <p>{lens.headline}</p>
        <table className="lens-checks">
          <thead>
            <tr>
              <th>Check</th>
              <th>The bar</th>
              <th className="num">Measured</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {lens.checks.map((c) => (
              <tr key={c.id}>
                <td>
                  {c.label}
                  <div className="subtle">{c.note}</div>
                </td>
                <td className="subtle">{c.bar}</td>
                <td className="num">{c.value ?? "—"}</td>
                <td>
                  <span className={`pill ${STATUS_TONE[c.status]}`}>{STATUS_LABEL[c.status]}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="subtle">
          {lens.scope} Source: {lens.source}.
        </p>
        {lens.notMeasured.length > 0 && (
          <div>
            <p className="subtle">Not measured — what {lens.name} also weighed that no figure here answers:</p>
            <ul className="lens-unmeasured">
              {lens.notMeasured.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </details>
  );
}

// The eight investors' tests run on the company's own figures. A lens is a way
// of looking at the company, never a recommendation; the verdict stays with the
// pre-investment checklist above. Pure over the report, so it renders without
// a database.
export function LensesView({ report }: { report: LensReport }) {
  const { tally } = report;
  return (
    <section className="panel" id="lenses">
      <div className="panel-head">
        <h2>Investor lenses</h2>
        <span className="hint">
          {report.years} {report.years === 1 ? "year" : "years"} of filings · as of {report.asOf}
        </span>
      </div>
      <div className="panel-body stack-sm">
        <p>
          {(["fits", "mixed", "does_not_fit", "unscored"] as const)
            .filter((fit) => tally[fit] > 0)
            .map((fit) => (
              <span key={fit}>
                <span className={`pill ${FIT_TONE[fit]}`}>
                  {tally[fit]} {FIT_LABEL[fit].toLowerCase()}
                </span>{" "}
              </span>
            ))}
        </p>
        {report.warnings.map((w) => (
          <p key={w} className="subtle">
            {w}
          </p>
        ))}
        <div className="lens-list">
          {report.lenses.map((lens) => (
            <Lens key={lens.id} lens={lens} />
          ))}
        </div>
        <p className="subtle">
          Each lens runs a published investor&apos;s tests on this company&apos;s own annual figures, computed by code with no model. It
          fits at {share(LENS_RULES.fits)} or more of the weight it could measure, does not fit at {share(LENS_RULES.doesNotFit)} or
          less, and says so when under {share(LENS_RULES.minCoverage)} of its weight could be measured. A lens is a way of looking, not
          a recommendation: the checklist above decides whether the company clears your own guide.
        </p>
      </div>
    </section>
  );
}

// Rendered inside Suspense: it reads ten years of facts and a year of prices.
export async function LensesPanel({ company }: { company: { id: string; ticker: string; name: string; sector: string | null } }) {
  let report;
  try {
    report = await lensRead(company);
  } catch (err) {
    return (
      <section className="panel" id="lenses">
        <div className="panel-head">
          <h2>Investor lenses</h2>
        </div>
        <p className="missing" style={{ padding: "0.9rem" }}>
          The lenses could not be run: {err instanceof Error ? err.message : "unknown error"}.
        </p>
      </section>
    );
  }
  return <LensesView report={report} />;
}
