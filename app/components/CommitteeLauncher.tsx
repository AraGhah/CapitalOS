"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { MODES, modeSpec, plannedCalls, type Mode } from "@/lib/ai/modes";

interface ModelOption {
  id: string;
  label: string;
  tier: string;
  provider: string;
}

interface PlanPhase {
  id: string;
  label: string;
  seats: Array<{ agent: string; model: string }>;
}

interface CallLine {
  agent: string;
  model: string;
  ok: boolean;
  tokens: number;
  ms: number;
  error?: string;
}

type PhaseState = "idle" | "running" | "done";

/* ---------------------------------------------------------------------------
   Convene a committee. The run streams one event per line — the plan, each
   phase starting and finishing, each model call as it lands — so the page
   shows the committee working rather than a spinner. When it is done the
   stored report is opened.
--------------------------------------------------------------------------- */

export function CommitteeLauncher({
  models,
  initialTicker,
}: {
  models: ModelOption[];
  initialTicker?: string;
}) {
  const router = useRouter();
  const [ticker, setTicker] = useState(initialTicker ?? "");
  const [focus, setFocus] = useState("");
  const [mode, setMode] = useState<Mode>("standard");
  const [selected, setSelected] = useState<string[]>(models.map((m) => m.id));
  const [force, setForce] = useState(false);

  const [running, setRunning] = useState(false);
  const [plan, setPlan] = useState<{ phases: PlanPhase[]; calls: number; mode: string } | null>(null);
  const [phases, setPhases] = useState<Record<string, PhaseState>>({});
  const [notes, setNotes] = useState<string[]>([]);
  const [calls, setCalls] = useState<CallLine[]>([]);
  const [error, setError] = useState<string | null>(null);

  const seats = Math.min(selected.length, modeSpec(mode).seats);

  function toggle(id: string) {
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  }

  async function run(e: FormEvent) {
    e.preventDefault();
    if (!ticker.trim() || selected.length === 0) return;

    setRunning(true);
    setPlan(null);
    setPhases({});
    setNotes([]);
    setCalls([]);
    setError(null);

    try {
      const res = await fetch("/api/consensus", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticker: ticker.trim(), mode, focus, modelIds: selected, force }),
      });
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `the desk refused the run (${res.status})`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) if (line.trim()) handle(JSON.parse(line));
      }
      if (buffer.trim()) handle(JSON.parse(buffer));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }

  function handle(event: Record<string, unknown>) {
    switch (event.type) {
      case "plan":
        setPlan({ phases: event.phases as PlanPhase[], calls: event.calls as number, mode: event.mode as string });
        break;
      case "phase":
        setPhases((p) => ({ ...p, [event.phase as string]: event.status === "running" ? "running" : "done" }));
        if (event.note) setNotes((n) => [...n, String(event.note)]);
        break;
      case "call":
        setCalls((c) => [...c, event as unknown as CallLine]);
        break;
      case "cached":
        setNotes((n) => [...n, "Identical evidence and line-up — opening the stored report instead of paying twice."]);
        router.push(`/committee/${event.runId}`);
        break;
      case "done":
        router.push(`/committee/${event.runId}`);
        break;
      case "error":
        setError(String(event.message));
        break;
    }
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Convene a committee</h2>
        <span className="hint">every model reads the same evidence</span>
      </div>

      <form className="panel-body stack-sm" onSubmit={run}>
        <div className="field-row">
          <label className="field">
            Ticker
            <input
              value={ticker}
              onChange={(e) => setTicker(e.target.value.toUpperCase())}
              placeholder="NVDA"
              spellCheck={false}
              autoComplete="off"
              required
              disabled={running}
            />
          </label>
          <label className="field">
            Question for the committee (optional)
            <input
              value={focus}
              onChange={(e) => setFocus(e.target.value)}
              placeholder="Does expected growth justify the valuation?"
              disabled={running}
            />
          </label>
        </div>

        <div className="field">
          Compute mode
          <div className="modes" role="radiogroup" aria-label="Compute mode">
            {MODES.map((m) => (
              <label key={m.id} className="mode-card">
                <input
                  type="radio"
                  name="mode"
                  value={m.id}
                  checked={mode === m.id}
                  onChange={() => setMode(m.id)}
                  disabled={running}
                />
                <span className="mode-name">{m.label}</span>
                <span className="mode-desc">{m.description}</span>
                <span className="mode-calls">
                  ~{plannedCalls(m.id, Math.max(1, selected.length))} model calls
                </span>
              </label>
            ))}
          </div>
        </div>

        <div className="field">
          Analyst seats — {seats} of {selected.length} selected will sit
          <div className="filters">
            {models.map((m) => (
              <button
                key={m.id}
                type="button"
                className="chip"
                aria-pressed={selected.includes(m.id)}
                onClick={() => toggle(m.id)}
                disabled={running}
                title={`${m.provider} · ${m.tier}`}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>

        <div className="inline-actions">
          <button className="primary" type="submit" disabled={running || !ticker.trim() || selected.length === 0}>
            {running ? "The committee is sitting…" : `Run ${modeSpec(mode).label.toLowerCase()}`}
          </button>
          <label className="subtle" style={{ display: "inline-flex", gap: "0.35rem", alignItems: "center" }}>
            <input
              type="checkbox"
              checked={force}
              onChange={(e) => setForce(e.target.checked)}
              style={{ width: "auto" }}
              disabled={running}
            />
            ignore the cache
          </label>
        </div>
        <p className="subtle">
          An identical committee on identical evidence is served from the ledger rather than billed twice.
          Different providers make for more useful disagreement than different sizes of one model.
        </p>
      </form>

      {plan && (
        <div className="panel-body" style={{ borderTop: "1px solid var(--border)" }}>
          <div className="stages wrap">
            {plan.phases.map((phase, i) => {
              const state = phases[phase.id] ?? "idle";
              return (
                <div key={phase.id} style={{ display: "contents" }}>
                  {i > 0 && (
                    <div className="stage-link">
                      <span style={{ width: phases[plan.phases[i - 1].id] === "done" ? "100%" : "0%" }} />
                    </div>
                  )}
                  <div
                    className={`stage ${state === "done" ? "done" : state === "running" ? "active" : ""}`.trim()}
                    style={{ width: "6.2rem" }}
                    title={phase.seats.map((s) => `${s.agent}: ${s.model}`).join("\n")}
                  >
                    <span className="bead" />
                    <span className="name">{phase.label}</span>
                    <span className="count">
                      {phase.seats.length} {phase.seats.length === 1 ? "seat" : "seats"}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
          <p className="subtle" style={{ marginTop: "0.6rem" }}>
            About {plan.calls} model calls planned. Hover a phase to see who sits in it.
          </p>
          {notes.map((note, i) => (
            <p key={i} className="subtle">
              {note}
            </p>
          ))}
        </div>
      )}

      {calls.length > 0 && (
        <ul className="call-log" style={{ borderTop: "1px solid var(--border)" }}>
          {calls.map((c, i) => (
            <li key={i}>
              <span className={c.ok ? "ok" : "fail"}>{c.ok ? "✓" : "✕"}</span>
              <span>
                {c.agent} <span className="subtle">· {c.model}</span>
                {c.error && <span className="subtle"> — {c.error}</span>}
              </span>
              <span className="meta">
                {c.tokens.toLocaleString()} tok · {(c.ms / 1000).toFixed(1)}s
              </span>
            </li>
          ))}
        </ul>
      )}

      {error && (
        <div className="panel-body" style={{ borderTop: "1px solid var(--border)" }}>
          <p className="alert">{error}</p>
        </div>
      )}
    </section>
  );
}
