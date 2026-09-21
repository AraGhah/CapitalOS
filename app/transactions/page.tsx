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
    loadRows();
  }

  return (
    <div>
      <h1>Transactions</h1>

      <form onSubmit={handleSubmit}>
        <label>
          Ticker
          <input
            value={form.ticker}
            onChange={(e) => setForm({ ...form, ticker: e.target.value })}
            required
          />
        </label>

        <label>
          Side
          <select value={form.side} onChange={(e) => setForm({ ...form, side: e.target.value })}>
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

        <button type="submit">Add transaction</button>
        {status && <span>{status}</span>}
      </form>

      <h1 style={{ marginTop: "2rem" }}>Recent</h1>
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
              <td style={{ textAlign: "left" }}>{r.ticker}</td>
              <td>{r.side}</td>
              <td>{r.qty}</td>
              <td>{r.price}</td>
              <td>{r.fees}</td>
              <td>{new Date(r.executed_at).toLocaleDateString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
