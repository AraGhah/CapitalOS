"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";

interface WatchRow {
  ticker: string;
  name: string;
  sector: string | null;
  addedAt: string;
  note: string | null;
}

export default function WatchlistPage() {
  const [rows, setRows] = useState<WatchRow[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [form, setForm] = useState({ ticker: "", note: "" });

  async function loadRows(): Promise<WatchRow[]> {
    const res = await fetch("/api/watchlist");
    return res.json();
  }

  useEffect(() => {
    loadRows().then(setRows);
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setStatus(null);

    const res = await fetch("/api/watchlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });

    if (!res.ok) {
      const body = await res.json();
      setStatus(body.error ?? "something went wrong");
      return;
    }

    setForm({ ticker: "", note: "" });
    setStatus("added");
    setRows(await loadRows());
  }

  async function remove(ticker: string) {
    await fetch(`/api/watchlist?ticker=${encodeURIComponent(ticker)}`, { method: "DELETE" });
    setRows(await loadRows());
  }

  return (
    <div>
      <h1>Watchlist</h1>

      <form onSubmit={handleSubmit}>
        <label>
          Ticker
          <input
            value={form.ticker}
            onChange={(e) => setForm({ ...form, ticker: e.target.value.toUpperCase() })}
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
        <button type="submit">Add</button>
      </form>
      {status && <p className="subtle">{status}</p>}

      <table style={{ marginTop: "1.5rem" }}>
        <thead>
          <tr>
            <th>Ticker</th>
            <th>Sector</th>
            <th>Note</th>
            <th>Added</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.ticker}>
              <td>
                <Link href={`/research/${row.ticker}`}>{row.ticker}</Link>
              </td>
              <td style={{ textAlign: "right" }}>{row.sector ?? "—"}</td>
              <td style={{ textAlign: "right" }}>{row.note ?? "—"}</td>
              <td>{row.addedAt.slice(0, 10)}</td>
              <td>
                <button type="button" className="linklike" onClick={() => remove(row.ticker)}>
                  remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <p className="missing">Nothing on the watchlist yet.</p>}
    </div>
  );
}
