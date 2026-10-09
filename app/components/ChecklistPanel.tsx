import Link from "next/link";
import type { Actor } from "@/lib/actor";
import { buildChecklist } from "@/lib/checklist-data";
import type { ChecklistItem, Group, Status, VerdictLevel } from "@/lib/checklist";

const PILL: Record<Status, string> = { pass: "good", caution: "warn", fail: "bad", missing: "", input: "info" };
const STATUS_LABEL: Record<Status, string> = { pass: "pass", caution: "caution", fail: "fail", missing: "no data", input: "your answer" };
const VERDICT_TONE: Record<VerdictLevel, string> = {
  not_ready: "bad",
  incomplete: "info",
  material_risks: "bad",
  caution: "warn",
  ready: "good",
};
const VERDICT_LABEL: Record<VerdictLevel, string> = {
  not_ready: "not ready",
  incomplete: "incomplete",
  material_risks: "material risks",
  caution: "proceed with care",
  ready: "all clear",
};
const GROUPS: Group[] = ["You", "The business", "The price", "The economy", "Your portfolio", "Costs and safety", "Your plan"];

function Item({ item }: { item: ChecklistItem }) {
  const detail = item.facts.length > 0 || item.gaps.length > 0;
  return (
    <li className="check-item">
      <span className={`pill ${PILL[item.status]}`}>{STATUS_LABEL[item.status]}</span>
      <div className="check-body">
        <p>
          <strong>{item.category}</strong> <span className="subtle">— {item.question}</span>
        </p>
        <p>{item.finding}</p>
        {detail && (
          <details className="why-box">
            <summary>Figures{item.gaps.length > 0 ? " and what was not verified" : ""}</summary>
            {item.facts.length > 0 && (
              <table className="check-facts">
                <tbody>
                  {item.facts.map((f, i) => (
                    <tr key={i}>
                      <td className="wide">{f.label}</td>
                      <td className="num">{f.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {item.gaps.map((g, i) => (
              <p key={i} className="missing">
                {g}
              </p>
            ))}
            <p className="subtle">Investor guide {item.guide}</p>
          </details>
        )}
      </div>
    </li>
  );
}

// Every question on the investor's checklist for this company, answered by
// code against the person's profile. Rendered inside Suspense: it loads a year
// of prices and the rest of the page should not wait for it.
export async function ChecklistPanel({ actor, ticker }: { actor: Pick<Actor, "userId" | "accountId">; ticker: string }) {
  let checklist;
  try {
    checklist = await buildChecklist(actor, ticker);
  } catch (err) {
    return (
      <section className="panel" id="checklist">
        <div className="panel-head">
          <h2>Pre-investment checklist</h2>
        </div>
        <p className="missing" style={{ padding: "0.9rem" }}>
          The checklist could not be built: {err instanceof Error ? err.message : "unknown error"}.
        </p>
      </section>
    );
  }
  const { verdict } = checklist;

  return (
    <section className="panel" id="checklist">
      <div className="panel-head">
        <h2>Pre-investment checklist</h2>
        <span className="hint">
          {verdict.counts.pass} pass · {verdict.counts.caution} caution · {verdict.counts.fail} fail ·{" "}
          {verdict.counts.missing + verdict.counts.input} unanswered
        </span>
      </div>
      <div className="panel-body stack-sm">
        <p className="check-verdict">
          <span className={`pill ${VERDICT_TONE[verdict.level]}`}>{VERDICT_LABEL[verdict.level]}</span>{" "}
          <span>{verdict.headline}</span>
        </p>
        {verdict.counts.input > 0 && (
          <p className="subtle">
            Questions only you can answer go on your <Link href="/profile">investor profile</Link>; your reasons and
            your exit rules go on a thesis.
          </p>
        )}
        {GROUPS.map((group) => {
          const items = checklist.items.filter((i) => i.group === group);
          if (items.length === 0) return null;
          return (
            <div key={group}>
              <h3 className="check-group">{group}</h3>
              <ul className="check-list">
                {items.map((i) => (
                  <Item key={i.id} item={i} />
                ))}
              </ul>
            </div>
          );
        })}
        <p className="subtle">
          Computed by code from {checklist.sources.join("; ")}. Thresholds are fixed and listed in lib/checklist.ts. Not
          advice: a pass means the desk&apos;s data cleared the bar, and each item says what it could not verify.
        </p>
      </div>
    </section>
  );
}
