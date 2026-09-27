"use client";

import { useEffect, useState } from "react";
import { PriceChart, type PricePoint } from "./PriceChart";

interface Chart {
  ticker: string;
  currency: string | null;
  price: number | null;
  previousClose: number | null;
  changePct: number | null;
  bars: Array<{ date: string; open: number | null; high: number | null; low: number | null; close: number | null }>;
}

// The price card asks Yahoo directly on mount, so it is current rather than as old
// as the last ingest run. If Yahoo is unreachable the card says so and the stored
// bars passed in as a fallback are shown instead.
export function LivePrice({ ticker, fallback }: { ticker: string; fallback: PricePoint[] }) {
  const [chart, setChart] = useState<Chart | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetch(`/api/quote/${encodeURIComponent(ticker)}`)
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? `quote failed (${res.status})`);
        return body as Chart;
      })
      .then((body) => {
        if (!cancelled) setChart(body);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });

    return () => {
      cancelled = true;
    };
  }, [ticker]);

  const points: PricePoint[] = chart
    ? chart.bars.map((b) => ({
        date: b.date.slice(5),
        close: b.close,
        low: b.low,
        range: b.low !== null && b.high !== null ? b.high - b.low : null,
      }))
    : fallback;

  const first = points.find((p) => p.close !== null)?.close ?? null;
  const lastClose = [...points].reverse().find((p) => p.close !== null)?.close ?? null;
  const movePct =
    chart?.changePct ?? (first && lastClose ? ((lastClose - first) / first) * 100 : null);
  const price = chart?.price ?? lastClose;

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Price</h2>
        <span className="hint">
          {chart
            ? "Yahoo Finance, one month"
            : error
              ? "live quote unavailable — showing stored bars"
              : "loading…"}
        </span>
      </div>

      <div className="verdict" style={{ paddingBottom: 0 }}>
        <div>
          <div className="verdict-word" style={{ fontSize: "1.6rem", fontWeight: 600 }}>
            {price === null ? "—" : price.toFixed(2)}
          </div>
          <div className="verdict-meta">
            {movePct !== null && (
              <span className={`pill ${movePct >= 0 ? "good" : "bad"}`}>
                {movePct >= 0 ? "+" : ""}
                {movePct.toFixed(2)}%
              </span>
            )}
            {chart?.previousClose != null && (
              <span className="pill">prev {chart.previousClose.toFixed(2)}</span>
            )}
            {chart?.currency && <span className="pill">{chart.currency}</span>}
          </div>
        </div>
      </div>

      <div className="panel-body">
        <PriceChart data={points} up={(movePct ?? 0) >= 0} />
        {error && <p className="missing">{error}</p>}
      </div>
    </section>
  );
}
