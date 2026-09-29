"use client";

import Link from "next/link";
import { useState } from "react";

export function AdoptThesis({ runId, rules }: { runId: string; rules: string[] }) {
  const [state, setState] = useState<"idle" | "saving" | "done">("idle");
  const [error, setError] = useState<string | null>(null);

  async function adopt() {
    setState("saving");
    setError(null);
    const res = await fetch(`/api/consensus/${runId}/adopt`, { method: "POST" });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(body.error ?? "the thesis could not be opened");
      setState("idle");
      return;
    }
    setState("done");
  }

  if (state === "done") {
    return (
      <p className="subtle">
        Thesis opened. It is checked by rule after every filing — see it on the <Link href="/">Command Center</Link>.
      </p>
    );
  }

  return (
    <div className="stack-sm">
      <div className="inline-actions">
        <button className="primary" type="button" onClick={adopt} disabled={state === "saving"}>
          {state === "saving" ? "Opening…" : "Adopt as a monitored thesis"}
        </button>
        <span className="subtle">{rules.join(" · ")}</span>
      </div>
      {error && <p className="alert">{error}</p>}
    </div>
  );
}
