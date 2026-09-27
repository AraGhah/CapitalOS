"use client";

import { useEffect, useState, type FormEvent } from "react";

interface TxnRow {
  id: string;
  ticker: string;
  side: "buy" | "sell";
  qty: string;
  price: string;
  fees: string;
  executed_at: string;
}

export default function TransactionsPage() {
  const [rows, setRows] = useState<TxnRow[]>([]);
  const [status, setStatus] = useState<string | null>(null);

  const [form, setForm] = useState({
    ticker: "",
    side: "buy",
    qty: "",
    price: "",
    fees: "0",
    executedAt: new Date().toISOString().slice(0, 10),
  });

  async function loadRows(): Promise<TxnRow[]> {
    const res = await fetch("/api/transactions");
    return res.json();
  }

  useEffect(() => {
    loadRows().then(setRows);
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setStatus(null);

    const res = await fetch("/api/transactions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });

    if (!res.ok) {
      const body = await res.json();
      setStatus(body.error ?? "something went wrong");
      return;
    }

    setForm((f) => ({ ...f, qty: "", price: "", fees: "0" }));
    setStatus("saved");
    setRows(await loadRows());
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <p className="eyebrow">Every position starts here</p>
          <h1>Ledger</h1>
        </div>
      </div>

      <section className="panel" style={{ marginBottom: "1rem" }}>
        <div className="panel-head">
          <h2>New transaction</h2>
          <span className="hint">cost basis is computed from these rows, never stored</span>
        </div>
        <div className="panel-body">
          <form className="form" onSubmit={handleSubmit}>
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
              Side
              <select
                value={form.side}
                onChange={(e) => setForm({ ...form, side: e.target.value })}
              >
                <option value="buy">Buy</option>
                <option value="sell">Sell</option>
              </select>
            </label>

            <label>
              Quantity
              <input
                type="number"
                step="any"
                value={form.qty}
                onChange={(e) => setForm({ ...form, qty: e.target.value })}
                required
              />
            </label>

            <label>
              Price
              <input
                type="number"
                step="any"
                value={form.price}
                onChange={(e) => setForm({ ...form, price: e.target.value })}
                required
              />
            </label>

            <label>
              Fees
              <input
                type="number"
                step="any"
                value={form.fees}
                onChange={(e) => setForm({ ...form, fees: e.target.value })}
              />
            </label>

            <label>
              Date
              <input
                type="date"
                value={form.executedAt}
                onChange={(e) => setForm({ ...form, executedAt: e.target.value })}
                required
              />
            </label>

            <button className="primary" type="submit">
              Add transaction
            </button>
          </form>
          {status && (
            <p className="subtle" style={{ marginTop: "0.6rem" }}>
              {status}
            </p>
          )}
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Recent</h2>
          <span className="hint">newest first</span>
        </div>
        <div className="panel-scroll">
          <table>
            <thead>
              <tr>
                <th>Ticker</th>
                <th>Side</th>
                <th>Qty</th>
                <th>Price</th>
                <th>Fees</th>
                <th>Date</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <span className="sym">{r.ticker}</span>
                  </td>
                  <td>
                    <span className={`pill ${r.side === "buy" ? "good" : "bad"}`}>{r.side}</span>
                  </td>
                  <td className="num">{r.qty}</td>
                  <td className="num">{r.price}</td>
                  <td className="num">{r.fees}</td>
                  <td className="num">{r.executed_at.slice(0, 10)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rows.length === 0 && (
          <p className="missing" style={{ padding: "0.9rem" }}>
            No transactions recorded yet.
          </p>
        )}
      </section>
    </div>
  );
}
