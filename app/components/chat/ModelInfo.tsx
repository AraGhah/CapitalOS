"use client";

import Link from "next/link";
import { providerName, type ModelUse } from "@/lib/chat-format";

const UNAVAILABLE = "Model information unavailable";

function sourceNote(m: ModelUse): string {
  return m.reportedBy === "api-response"
    ? "Identifier as reported in the provider's API response"
    : "Identifier as recorded in the run's model-call log";
}

function Identifier({ model }: { model: ModelUse }) {
  return model.model ? (
    <code className="model-id" title={sourceNote(model)}>
      {model.model}
    </code>
  ) : (
    <span className="subtle">{UNAVAILABLE}</span>
  );
}

function Notes({ model }: { model: ModelUse }) {
  return (
    <>
      {model.reused && (
        <span className="pill" title="This tool reused the result of an earlier run with identical inputs">
          reused run
        </span>
      )}
      {(model.failed ?? 0) > 0 && (
        <span className="pill bad">
          {model.failed} of {model.calls} failed
        </span>
      )}
    </>
  );
}

// Which models produced an answer, taken from what was stored with it. Old
// answers saved before this was recorded say so instead of guessing.
export function ModelInfo({ models }: { models?: ModelUse[] }) {
  if (!models || models.length === 0) {
    return (
      <div className="model-info">
        <span className="model-info-label">AI model</span>
        <span className="subtle">{UNAVAILABLE}</span>
      </div>
    );
  }

  const [primary, ...others] = models;
  const distinct = new Set(models.map((m) => `${m.provider}/${m.model ?? "?"}`)).size;

  if (others.length === 0) {
    return (
      <div className="model-info">
        <span className="model-info-label">AI model</span>
        <span className="model-info-line">
          <span>{providerName(primary.provider)}</span>
          <Identifier model={primary} />
          <span className="model-role">{primary.role}</span>
          <Notes model={primary} />
        </span>
      </div>
    );
  }

  return (
    <details className="model-info model-info-multi">
      <summary>
        <span className="model-info-label">AI models</span>
        <span className="model-info-line">
          <span>{providerName(primary.provider)}</span>
          <Identifier model={primary} />
          <span className="model-role">
            and others: {distinct} {distinct === 1 ? "model" : "models"} in {models.length} roles took part
          </span>
          <span className="model-more" aria-hidden="true">
            show all
          </span>
        </span>
      </summary>
      <div className="md-table" role="region" aria-label="Models that produced this answer" tabIndex={0}>
        <table className="model-table">
          <thead>
            <tr>
              <th>Provider</th>
              <th>Model</th>
              <th>Role</th>
              <th>Calls</th>
            </tr>
          </thead>
          <tbody>
            {models.map((m, i) => (
              <tr key={i}>
                <td>{providerName(m.provider)}</td>
                <td>
                  <Identifier model={m} />
                </td>
                <td className="wrap">
                  {m.role} <Notes model={m} />
                  {m.link && (
                    <>
                      {" "}
                      <Link href={m.link} className="model-link">
                        record
                      </Link>
                    </>
                  )}
                </td>
                <td className="num">{m.calls}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
