"use client";

import { useState } from "react";
import type { Dossier, FeedReport } from "@/lib/dossier";
import { timeAgo } from "@/lib/format";
import { startAndFollow } from "@/app/components/jobs";

/* ---------------------------------------------------------------------------
   Scout → Analyst → Strategist.

   The run streams newline-delimited JSON, one object per phase, so the pipeline
   fill advances when an agent actually finishes rather than on a timer.
--------------------------------------------------------------------------- */

type Phase = "scout" | "analyst" | "strategist";
type PhaseState = "idle" | "running" | "done";

const PHASES: Array<{ id: Phase; name: string; does: string }> = [
  { id: "scout", name: "Scout", does: "gathers headlines from five public feeds" },
  { id: "analyst", name: "Analyst", does: "reads every headline and labels its sentiment" },
  { id: "strategist", name: "Strategist", does: "issues the verdict and writes the brief" },
];

interface Progress {
  scout: PhaseState;
  analyst: PhaseState;
  strategist: PhaseState;
}

const IDLE: Progress = { scout: "idle", analyst: "idle", strategist: "idle" };

export function DeskRunner({
  ticker,
  initialDossier,
}: {
  ticker: string;
  initialDossier: Dossier | null;
}) {
  const [dossier, setDossier] = useState<Dossier | null>(initialDossier);
  const [progress, setProgress] = useState<Progress>(IDLE);
  const [running, setRunning] = useState(false);
  const [notes, setNotes] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function run(force: boolean) {
    setRunning(true);
    setError(null);
    setNotes([]);
    setProgress(IDLE);

    try {
      const outcome = await startAndFollow(
        `/api/research/${encodeURIComponent(ticker)}${force ? "?force=1" : ""}`,
        { method: "POST" },
        handleEvent,
        (notice) => setNotes((n) => [...n, notice])
      );
      if (outcome.status !== "succeeded") setError(outcome.error ?? `the run ended ${outcome.status}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }

  function handleEvent(event: Record<string, unknown>) {
    if (event.type === "retrying") {
      setNotes((n) => [...n, "A feed or model call failed; the run will be retried shortly."]);
      return;
    }
    const phase = event.phase as Phase | "cached" | "error";

    if (phase === "error") {
      setError(String(event.message));
      return;
    }

    if (phase === "cached") {
      setDossier(event.dossier as Dossier);
      setProgress({ scout: "done", analyst: "done", strategist: "done" });
      setNotes((n) => [...n, "Nothing new since the last run — showing the stored dossier."]);
      return;
    }

    setProgress((p) => ({ ...p, [phase]: event.status as PhaseState }));

    if (event.status !== "done") return;

    if (phase === "scout") {
      const feeds = (event.feeds as FeedReport[]) ?? [];
      const reachable = feeds.filter((f) => !f.error).length;
      setNotes((n) => [
        ...n,
        `Scout: ${event.fetched} headlines from ${reachable} of ${feeds.length} feeds, ${event.stored} new.`,
        ...feeds.filter((f) => f.error).map((f) => `${f.label} unreachable: ${f.error}`),
      ]);
    }

    if (phase === "analyst") {
      setNotes((n) => [...n, `Analyst: ${event.tagged} newly labelled by ${event.provider}.`]);
    }

    if (phase === "strategist") {
      setDossier(event.dossier as Dossier);
    }
  }

  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <h2>Agent pipeline</h2>
          {dossier && <span className="hint">last run {timeAgo(dossier.createdAt)}</span>}
        </div>

        <div className="panel-body">
          <div className="stages">
            {PHASES.map((phase, i) => (
              <div key={phase.id} style={{ display: "contents" }}>
                {i > 0 && (
                  <div className="stage-link">
                    <span
                      style={{ width: progress[PHASES[i - 1].id] === "done" ? "100%" : "0%" }}
                    />
                  </div>
                )}
                <div
                  className={`stage ${
                    progress[phase.id] === "done"
                      ? "done"
                      : progress[phase.id] === "running"
                        ? "active"
                        : ""
                  }`.trim()}
                  style={{ width: "5.5rem" }}
                  title={phase.does}
                >
                  <span className="bead" />
                  <span className="name">{phase.name}</span>
                  <span className="count">
                    {progress[phase.id] === "running"
                      ? "working"
                      : progress[phase.id] === "done"
                        ? "done"
                        : "—"}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="runner" style={{ borderTop: "1px solid var(--border)" }}>
          <button className="primary" type="button" onClick={() => run(false)} disabled={running}>
            {running ? "Running…" : dossier ? "Run again" : "Run the desk"}
          </button>
          {dossier && !running && (
            <button className="chip" type="button" onClick={() => run(true)}>
              Force a fresh verdict
            </button>
          )}
          <span className="note">
            A run fetches live headlines, so it takes a moment. An unchanged headline set returns the
            stored dossier instead of paying for a second opinion.
          </span>
        </div>

        {(notes.length > 0 || error) && (
          <div className="panel-body" style={{ borderTop: "1px solid var(--border)" }}>
            {notes.map((note, i) => (
              <p key={i} className="subtle">
                {note}
              </p>
            ))}
            {error && (
              <p className="alert" style={{ marginTop: notes.length ? "0.5rem" : 0 }}>
                {error}
              </p>
            )}
          </div>
        )}
      </section>

      {dossier ? (
        <DossierView dossier={dossier} />
      ) : (
        <section className="panel">
          <div className="panel-body">
            <p className="missing">
              No dossier yet — run the pipeline to gather headlines and get a verdict.
            </p>
          </div>
        </section>
      )}
    </>
  );
}

/* ------------------------------------------------------------------- readouts */

function DossierView({ dossier }: { dossier: Dossier }) {
  const { brief, sentiment } = dossier;
  const hasBrief = brief.headline || brief.summary || brief.entryPlan;
  const hasCases = dossier.bull.length + dossier.bear.length + dossier.catalysts.length > 0;

  return (
    <>
      <VerdictCard dossier={dossier} />

      <section className="panel">
        <div className="panel-head">
          <h2>The brief</h2>
          <span className="hint">written from the headlines below, nothing else</span>
        </div>
        <div className="panel-body">
          {hasBrief ? (
            <>
              {brief.headline && <p className="brief-headline">{brief.headline}</p>}
              {brief.summary && <p className="brief-body">{brief.summary}</p>}
              {brief.entryPlan && (
                <div className="brief-plan">
                  <span className="label">When to buy</span>
                  {brief.entryPlan}
                </div>
              )}
            </>
          ) : (
            <p className="missing">
              No brief — the verdict above came from the sentiment counts alone. Add an{" "}
              <code>ANTHROPIC_API_KEY</code> to <code>.env.local</code> and run again to have the
              strategist write one.
            </p>
          )}
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>News sentiment</h2>
          <span className="hint">
            {sentiment.tagged} headlines labelled by {dossier.provider === "rules:sentiment-counts" ? "word list" : dossier.provider}
          </span>
        </div>
        <div className="panel-body">
          <div className="gauge">
            <div
              className="gauge-bar"
              role="img"
              aria-label={`sentiment ${sentiment.score.toFixed(0)} on a scale from -100 bearish to +100 bullish`}
            >
              {/* −100..+100 mapped onto the bar's width */}
              <span className="gauge-mark" style={{ left: `${(sentiment.score + 100) / 2}%` }} />
            </div>
            <div className="gauge-scale">
              <span>bearish</span>
              <span>neutral</span>
              <span>bullish</span>
            </div>
          </div>
          <div className="sentiment-counts">
            <div>
              <span className="n up">{sentiment.bullish}</span>
              <span className="k">bullish</span>
            </div>
            <div>
              <span className="n">{sentiment.neutral}</span>
              <span className="k">neutral</span>
            </div>
            <div>
              <span className="n down">{sentiment.bearish}</span>
              <span className="k">bearish</span>
            </div>
          </div>
        </div>
      </section>

      {hasCases && (
        <section className="panel">
          <div className="panel-head">
            <h2>Bull, bear and what to watch</h2>
          </div>
          <div className="panel-body three-up">
            <CaseList kind="bull" title="Reasons to be optimistic" items={dossier.bull} />
            <CaseList kind="bear" title="Reasons to be careful" items={dossier.bear} />
            <CaseList kind="watch" title="Coming up" items={dossier.catalysts} />
          </div>
        </section>
      )}

      {dossier.feeds.length > 0 && (
        <section className="panel">
          <div className="panel-head">
            <h2>Feeds on the last run</h2>
          </div>
          <ul className="rail">
            {dossier.feeds.map((feed) => (
              <li key={feed.feed}>
                <span
                  className="dot idle"
                  style={{ background: feed.error ? "var(--down)" : feed.count > 0 ? "var(--up)" : "var(--faint)" }}
                />
                <span className="feed-name" title={feed.error ?? undefined}>
                  {feed.label}
                </span>
                <span className={feed.error ? "count offline" : "count"}>
                  {feed.error ? "offline" : feed.count}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function VerdictCard({ dossier }: { dossier: Dossier }) {
  const share = dossier.confidence ?? 0;
  const size = 74;
  const stroke = 7;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Verdict</h2>
        <span className="hint">
          from {dossier.headlineCount} headlines · {dossier.provider}
        </span>
      </div>
      <div className="verdict">
        <div className="ring">
          <svg width={size} height={size} role="img" aria-label={`confidence ${(share * 100).toFixed(0)} of 100`}>
            <circle className="track" cx={size / 2} cy={size / 2} r={radius} fill="none" strokeWidth={stroke} />
            <circle
              className="fill"
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              strokeWidth={stroke}
              strokeDasharray={circumference}
              strokeDashoffset={circumference * (1 - share)}
            />
          </svg>
        </div>
        <div>
          <div className={`verdict-word ${dossier.verdict.toLowerCase()}`}>{dossier.verdict}</div>
          <div className="verdict-meta">
            <span className="pill">
              {dossier.confidence === null
                ? "confidence not given"
                : `${(dossier.confidence * 100).toFixed(0)}% confidence`}
            </span>
            {dossier.risk && (
              <span className={`pill ${dossier.risk === "high" ? "bad" : dossier.risk === "low" ? "good" : ""}`.trim()}>
                {dossier.risk} risk
              </span>
            )}
            {dossier.horizon && <span className="pill info">{dossier.horizon}</span>}
          </div>
        </div>
      </div>
      <p className="subtle" style={{ padding: "0 0.9rem 0.9rem" }}>
        A summary of public news, not financial advice. Verify anything here before acting on it.
      </p>
    </section>
  );
}

function CaseList({
  kind,
  title,
  items,
}: {
  kind: "bull" | "bear" | "watch";
  title: string;
  items: string[];
}) {
  return (
    <div>
      <h2 style={{ marginBottom: "0.5rem" }}>{title}</h2>
      {items.length === 0 ? (
        <p className="missing">Nothing recorded.</p>
      ) : (
        <ul className={`case-list ${kind}`}>
          {items.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
