"use client";

import { useState } from "react";

interface Brief {
  headline: string;
  summary: string;
  watch: string[];
  model: string;
  unverified: string[];
  writtenAt: string;
}

// Written on request, not on every page load: one model call, fact-checked
// against the numbers on this page.
export function MarketBrief({ hasModel }: { hasModel: boolean }) {
  const [brief, setBrief] = useState<Brief | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function write(force: boolean) {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/markets/brief${force ? "?force=1" : ""}`, { method: "POST" });
    const body = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setError(body.error ?? "the brief could not be written");
      return;
    }
    setBrief(body);
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Market brief</h2>
        <span className="hint">{brief ? `${brief.model} · every figure checked` : "written from the numbers below"}</span>
      </div>
      <div className="panel-body stack-sm">
        {brief ? (
          <>
            {brief.headline && <p className="brief-headline">{brief.headline}</p>}
            <p className="brief-body">{brief.summary}</p>
            {brief.watch.length > 0 && (
              <ul className="case-list watch">
                {brief.watch.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            )}
            {brief.unverified.length > 0 && (
              <p className="alert">
                Not found in the computed figures, treat as unverified: {brief.unverified.join(", ")}
              </p>
            )}
            <div className="inline-actions">
              <button type="button" className="chip" onClick={() => write(true)} disabled={busy}>
                {busy ? "Writing…" : "Write again"}
              </button>
            </div>
          </>
        ) : (
          <div className="inline-actions">
            <button type="button" className="primary" onClick={() => write(false)} disabled={busy || !hasModel}>
              {busy ? "Writing…" : "Write today's brief"}
            </button>
            <span className="subtle">
              {hasModel
                ? "One model call. The regime and the numbers below are computed by code either way."
                : "Needs a model key in .env.local; the numbers below do not."}
            </span>
          </div>
        )}
        {error && <p className="alert">{error}</p>}
      </div>
    </section>
  );
}
