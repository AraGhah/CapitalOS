import { notFound } from "next/navigation";
import { findCompany } from "@/lib/company";
import { RESEARCH_FIELDS, getResearchNote } from "@/lib/research";

export const dynamic = "force-dynamic";

const FIELD_LABELS: Record<string, string> = {
  outlook: "Outlook",
  catalysts: "Catalysts",
  risks: "Risks",
  bull_case: "Bull case",
  bear_case: "Bear case",
};

export default async function ResearchPage({ params }: PageProps<"/research/[ticker]">) {
  const { ticker } = await params;
  const company = await findCompany(ticker);
  if (!company) notFound();

  const note = await getResearchNote(company.id, company.ticker, company.name);
  const { coverage } = note;
  const missingInputs = coverage.inputs.filter((i) => !i.present);

  return (
    <div>
      <h1>
        {note.ticker} — {note.name}
      </h1>

      <div className="stat-row">
        <div className="stat">
          <span className="label">Inputs retrieved</span>
          <span className="value">
            {coverage.present} of {coverage.expected}
          </span>
        </div>
        <div className="stat">
          <span className="label">Fields researched</span>
          <span className="value">
            {coverage.fieldsWritten} of {RESEARCH_FIELDS.length}
          </span>
        </div>
        <div className="stat">
          <span className="label">Score component spread</span>
          <span className="value">
            {coverage.scoreSpread === null
              ? "—"
              : `${(coverage.scoreSpread * 100).toFixed(0)} pts`}
          </span>
        </div>
      </div>

      {missingInputs.length > 0 && (
        <p className="subtle">
          Not retrieved: {missingInputs.map((i) => i.name).join(", ")}.
        </p>
      )}

      {RESEARCH_FIELDS.map((field) => {
        const claims = note.fields[field];
        return (
          <section key={field} style={{ marginTop: "1.5rem" }}>
            <h2>{FIELD_LABELS[field]}</h2>

            {claims.length === 0 ? (
              <p className="missing">Not researched — no claim recorded.</p>
            ) : (
              claims.map((claim) => (
                <div key={claim.id} className="claim">
                  <p>{claim.text}</p>
                  <blockquote>{claim.snippet}</blockquote>
                  <a
                    className="subtle"
                    href={claim.source.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {claim.source.title ?? claim.source.url}
                  </a>
                </div>
              ))
            )}
          </section>
        );
      })}
    </div>
  );
}
