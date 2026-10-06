"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { request } from "@/app/components/request";

// A ticker the desk has not seen yet is only added when the person asks for it,
// so browsing (or a link prefetch) never creates rows.
export function AddToDesk({ ticker, name }: { ticker: string; name: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add() {
    setBusy(true);
    setError(null);
    const res = await request("/api/watchlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticker }),
    });
    const body = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setError(body.error ?? "the ticker could not be added");
      return;
    }
    router.refresh();
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Not on the desk yet</h2>
      </div>
      <div className="panel-body stack-sm">
        <p>
          <span className="num">{ticker}</span> is {name === ticker ? "a listed symbol" : name}. Add it to the
          watchlist to start tracking it and to research it here.
        </p>
        <button type="button" onClick={add} disabled={busy}>
          {busy ? "Adding…" : `Add ${ticker} to the desk`}
        </button>
        {error && <p className="missing">{error}</p>}
      </div>
    </section>
  );
}
