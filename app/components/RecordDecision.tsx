"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { request } from "@/app/components/request";

// Records the decision as it stands. Nothing is written until this is pressed:
// computing a decision is free and changes with the price, recording it keeps
// the inputs and the price it was drawn at.
export function RecordDecision({ runId }: { runId: string }) {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "saving" | "done" | "already">("idle");
  const [error, setError] = useState<string | null>(null);

  async function record() {
    setState("saving");
    setError(null);
    const res = await request(`/api/consensus/${runId}/decision`, { method: "POST" });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(body.error ?? "the decision could not be recorded");
      setState("idle");
      return;
    }
    setState(body.duplicate ? "already" : "done");
    router.refresh();
  }

  return (
    <div className="stack-sm">
      <div className="inline-actions">
        <button className="primary" type="button" onClick={record} disabled={state === "saving"}>
          {state === "saving" ? "Recording…" : "Record this decision"}
        </button>
        {state === "done" && <span className="subtle">Recorded, with the inputs and today&apos;s price.</span>}
        {state === "already" && <span className="subtle">Already recorded with these inputs.</span>}
      </div>
      {error && <p className="alert">{error}</p>}
    </div>
  );
}
