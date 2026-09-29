"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

// A simulated order, filled at the live price. With a runId it is tied to the
// committee conclusion it tests.
export function PaperOrder({
  ticker: initialTicker = "",
  runId,
  rationale,
  compact = false,
}: {
  ticker?: string;
  runId?: string;
  rationale?: string;
  compact?: boolean;
}) {
  const router = useRouter();
  const [ticker, setTicker] = useState(initialTicker);
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [dollars, setDollars] = useState("10000");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNote(null);
    const res = await fetch("/api/paper", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticker, side, dollars: Number(dollars), runId, rationale }),
    });
    const body = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setError(body.error ?? "the order failed");
      return;
    }
    setNote(`Filled: ${body.side} ${body.qty} ${body.ticker} at ${Number(body.price).toFixed(2)}.`);
    router.refresh();
  }

  return (
    <form className="stack-sm" onSubmit={submit}>
      <div className="inline-actions">
        {!compact && (
          <input
            value={ticker}
            onChange={(e) => setTicker(e.target.value.toUpperCase())}
            placeholder="Ticker"
            aria-label="Ticker"
            style={{ width: "7rem" }}
            required
          />
        )}
        {!compact && (
          <select value={side} onChange={(e) => setSide(e.target.value as "buy" | "sell")} aria-label="Side" style={{ width: "6rem" }}>
            <option value="buy">buy</option>
            <option value="sell">sell</option>
          </select>
        )}
        <input
          value={dollars}
          onChange={(e) => setDollars(e.target.value)}
          inputMode="decimal"
          aria-label="Dollars"
          style={{ width: "8rem" }}
        />
        <button className={compact ? "chip" : "primary"} type="submit" disabled={busy || !ticker || !(Number(dollars) > 0)}>
          {busy ? "Filling…" : compact ? `Paper-trade $${Number(dollars).toLocaleString()} of ${ticker}` : "Place paper order"}
        </button>
      </div>
      {note && <p className="subtle">{note}</p>}
      {error && <p className="alert">{error}</p>}
    </form>
  );
}
