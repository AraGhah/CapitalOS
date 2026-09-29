"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function AlertStatus({ id, status }: { id: string; status: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function set(next: "seen" | "dismissed" | "new") {
    setBusy(true);
    await fetch("/api/alerts", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, status: next }),
    });
    setBusy(false);
    router.refresh();
  }

  if (status !== "new") {
    return (
      <button type="button" className="linklike" onClick={() => set("new")} disabled={busy}>
        reopen
      </button>
    );
  }
  return (
    <span className="inline-actions" style={{ gap: "0.4rem" }}>
      <button type="button" className="chip" onClick={() => set("seen")} disabled={busy}>
        Reviewed
      </button>
      <button type="button" className="linklike" onClick={() => set("dismissed")} disabled={busy}>
        dismiss
      </button>
    </span>
  );
}

interface Summary {
  tracked: number;
  found: number;
  created: number;
  convened: Array<{ ticker: string; runId: string }>;
  skippedConvening: string | null;
  errors: string[];
}

// One pass of the loop on demand. Convening is a separate, explicit choice,
// because it is the only step that spends model calls.
export function RunCycle({ hasModel }: { hasModel: boolean }) {
  const router = useRouter();
  const [convene, setConvene] = useState(false);
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/autopilot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ convene }),
    });
    const body = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setError(body.error ?? "the pass failed");
      return;
    }
    setSummary(body);
    router.refresh();
  }

  return (
    <div className="stack-sm">
      <div className="inline-actions">
        <button type="button" className="primary" onClick={run} disabled={busy}>
          {busy ? "Watching…" : "Run a pass now"}
        </button>
        <label className="subtle" style={{ display: "inline-flex", gap: "0.35rem", alignItems: "center" }}>
          <input
            type="checkbox"
            checked={convene}
            onChange={(e) => setConvene(e.target.checked)}
            disabled={!hasModel || busy}
            style={{ width: "auto" }}
          />
          convene a committee on high-severity alerts
        </label>
      </div>
      {summary && (
        <p className="subtle">
          Watched {summary.tracked} companies: {summary.found} triggers, {summary.created} new alerts
          {summary.convened.length > 0 && `, ${summary.convened.length} committees convened`}.
          {summary.skippedConvening && ` ${summary.skippedConvening[0].toUpperCase()}${summary.skippedConvening.slice(1)}.`}
          {summary.errors.length > 0 && ` Problems: ${summary.errors.join("; ")}.`}
        </p>
      )}
      {error && <p className="alert">{error}</p>}
    </div>
  );
}
