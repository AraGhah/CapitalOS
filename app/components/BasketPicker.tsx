"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

// What the risk page measures: the ledger's open positions, the watchlist at
// equal weight, or a basket typed in to test an idea before any money moves.
export function BasketPicker({ basis, basket }: { basis: string; basket: string }) {
  const router = useRouter();
  const [text, setText] = useState(basket);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (text.trim()) router.push(`/risk?basket=${encodeURIComponent(text.trim())}`);
  }

  return (
    <div className="panel-body stack-sm">
      <div className="filters" role="tablist" aria-label="What to measure">
        <button type="button" className="chip" aria-pressed={basis === "holdings"} onClick={() => router.push("/risk")}>
          Open positions
        </button>
        <button type="button" className="chip" aria-pressed={basis === "watchlist"} onClick={() => router.push("/risk?source=watchlist")}>
          Watchlist, equal weight
        </button>
        <button type="button" className="chip" aria-pressed={basis === "custom"} onClick={() => document.getElementById("basket")?.focus()}>
          What-if basket
        </button>
      </div>
      <form className="composer" style={{ padding: 0, borderTop: "none" }} onSubmit={submit}>
        <input
          id="basket"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="NVDA:30, AMD:20, MSFT:30, XOM:20 — weights in any units, scaled to 100%"
          aria-label="What-if basket"
          spellCheck={false}
        />
        <button className="primary" type="submit" disabled={!text.trim()}>
          Measure
        </button>
      </form>
    </div>
  );
}
