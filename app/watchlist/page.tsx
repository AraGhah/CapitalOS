"use client";

import { request } from "@/app/components/request";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { Sparkline } from "@/app/components/Sparkline";

interface WatchRow {
  ticker: string;
  name: string;
  sector: string | null;
  addedAt: string;
  note: string | null;
  close: number | null;
  changePct: number | null;
  spark: number[];
  verdict: string | null;
  verdictAt: string | null;
}

// BUY and ACCUMULATE read as good, AVOID as bad, and HOLD/WAIT stay neutral
// rather than being nudged into one camp or the other.
function verdictTone(verdict: string): string {
  if (verdict === "BUY" || verdict === "ACCUMULATE") return "good";
  if (verdict === "AVOID") return "bad";
  return "";
}

export default function WatchlistPage() {
  const [rows, setRows] = useState<WatchRow[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [form, setForm] = useState({ ticker: "", note: "" });

  async function loadRows(): Promise<WatchRow[]> {
    const res = await request("/api/watchlist");
    // an error body is an object, not rows; the table shows empty rather than crashing
    if (!res.ok) return [];
    const body = await res.json().catch(() => []);
    return Array.isArray(body) ? body : [];
  }

  useEffect(() => {
    loadRows().then(setRows);
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setStatus(null);

    const res = await request("/api/watchlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setStatus(body.error ?? "something went wrong");
      return;
    }

    setForm({ ticker: "", note: "" });
    setStatus(`${form.ticker.toUpperCase()} added`);
    setRows(await loadRows());
  }

  async function remove(ticker: string) {
    await request(`/api/watchlist?ticker=${encodeURIComponent(ticker)}`, { method: "DELETE" });
    setStatus(`${ticker} removed`);
    setRows(await loadRows());
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <p className="eyebrow">Tracked, not held</p>
          <h1>Watchlist</h1>
        </div>
      </div>

      <div className="split">
        <div className="stack">
          <section className="panel">
            <div className="panel-head">
              <h2>Watching</h2>
              <span className="hint">
                {rows.length} {rows.length === 1 ? "company" : "companies"}
              </span>
            </div>
            <div className="panel-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Ticker</th>
                    <th></th>
                    <th>Last</th>
                    <th>Today</th>
                    <th>Verdict</th>
                    <th className="wide">Note</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.ticker}>
                      <td>
                        <Link href={`/research/${row.ticker}`} className="sym">
                          {row.ticker}
                        </Link>
                      </td>
                      <td>
                        <Sparkline values={row.spark} />
                      </td>
                      <td className="num">{row.close === null ? "—" : row.close.toFixed(2)}</td>
                      <td className={`num ${row.changePct === null ? "" : row.changePct >= 0 ? "up" : "down"}`}>
                        {row.changePct === null
                          ? "—"
                          : `${row.changePct >= 0 ? "+" : ""}${row.changePct.toFixed(2)}%`}
                      </td>
                      <td>
                        {row.verdict ? (
                          <span className={`pill ${verdictTone(row.verdict)}`.trim()}>
                            {row.verdict}
                          </span>
                        ) : (
                          <Link href={`/research/${row.ticker}`} className="subtle">
                            not run
                          </Link>
                        )}
                      </td>
                      <td className="wide">{row.note ?? "—"}</td>
                      <td>
                        <button
                          type="button"
                          className="linklike"
                          onClick={() => remove(row.ticker)}
                        >
                          remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {rows.length === 0 && (
              <p className="missing" style={{ padding: "0.9rem" }}>
                Nothing on the watchlist yet.
              </p>
            )}
          </section>
        </div>

        <div className="stack">
          <section className="panel">
            <div className="panel-head">
              <h2>Add a company</h2>
            </div>
            <div className="panel-body">
              <form className="form" onSubmit={handleSubmit} style={{ gridTemplateColumns: "1fr" }}>
                <label>
                  Ticker
                  <input
                    value={form.ticker}
                    onChange={(e) => setForm({ ...form, ticker: e.target.value.toUpperCase() })}
                    spellCheck={false}
                    autoComplete="off"
                    required
                  />
                </label>
                <label>
                  Note
                  <input
                    value={form.note}
                    onChange={(e) => setForm({ ...form, note: e.target.value })}
                    placeholder="why it is worth watching"
                  />
                </label>
                <button className="primary" type="submit">
                  Add
                </button>
              </form>
              {status && (
                <p className="subtle" style={{ marginTop: "0.6rem" }}>
                  {status}
                </p>
              )}
              <p className="subtle" style={{ marginTop: "0.6rem" }}>
                The company has to exist in <code>companies</code> first — the ingest scripts put it
                there.
              </p>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
