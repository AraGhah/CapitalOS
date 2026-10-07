"use client";

import { request } from "@/app/components/request";
import { AccountPanel } from "@/app/components/AccountPanel";

import { useEffect, useState, type FormEvent } from "react";

interface TxnRow {
  id: string;
  ticker: string;
  side: "buy" | "sell";
  qty: string;
  price: string;
  fees: string;
  executedAt: string;
  note: string | null;
  voidedAt: string | null;
  voidReason: string | null;
}

async function loadRows(voided: boolean): Promise<TxnRow[]> {
  const res = await request(`/api/transactions${voided ? "?voided=1" : ""}`);
  // an error body is an object, not rows; the table shows empty rather than crashing
  if (!res.ok) return [];
  const body = await res.json().catch(() => []);
  return Array.isArray(body) ? body : [];
}

export default function TransactionsPage() {
  const [rows, setRows] = useState<TxnRow[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [showVoided, setShowVoided] = useState(false);
  const [voiding, setVoiding] = useState<{ id: string; reason: string } | null>(null);
  // One key per form submission: a double click or a retried request is the
  // same transaction, not a second one.
  const [submissionKey, setSubmissionKey] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);

  const [form, setForm] = useState({
    ticker: "",
    side: "buy",
    qty: "",
    price: "",
    fees: "0",
    // the local calendar date; toISOString() is UTC, which is tomorrow by evening
    executedAt: new Date().toLocaleDateString("en-CA"),
  });

  useEffect(() => {
    loadRows(false).then(setRows);
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setStatus(null);

    const res = await request("/api/transactions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...form, idempotencyKey: submissionKey }),
    });
    setBusy(false);

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setStatus(body.error ?? "something went wrong");
      return;
    }

    setForm((f) => ({ ...f, qty: "", price: "", fees: "0" }));
    setSubmissionKey(crypto.randomUUID());
    setStatus("saved");
    setRows(await loadRows(showVoided));
  }

  async function confirmVoid(e: FormEvent) {
    e.preventDefault();
    if (!voiding) return;
    const res = await request(`/api/transactions/${voiding.id}/void`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: voiding.reason }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setStatus(body.error ?? "the void was refused");
      return;
    }
    setVoiding(null);
    setStatus("voided — the row stays on record, marked void");
    setRows(await loadRows(showVoided));
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <p className="eyebrow">Every position starts here</p>
          <h1>Ledger</h1>
        </div>
      </div>

      <AccountPanel />

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

            <button className="primary" type="submit" disabled={busy}>
              {busy ? "Saving…" : "Add transaction"}
            </button>
          </form>
          {status && (
            <p className="subtle" style={{ marginTop: "0.6rem" }} role="status" aria-live="polite">
              {status}
            </p>
          )}
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Recent</h2>
          <label className="hint">
            <input
              type="checkbox"
              checked={showVoided}
              onChange={async (e) => {
                setShowVoided(e.target.checked);
                setRows(await loadRows(e.target.checked));
              }}
            />{" "}
            show voided
          </label>
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
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={r.voidedAt ? "voided" : undefined}>
                  <td>
                    <span className="sym">{r.ticker}</span>
                    {r.voidedAt && (
                      <span className="pill" title={r.voidReason ?? undefined}>
                        void
                      </span>
                    )}
                  </td>
                  <td>
                    <span className={`pill ${r.side === "buy" ? "good" : "bad"}`}>{r.side}</span>
                  </td>
                  <td className="num">{r.qty}</td>
                  <td className="num">{r.price}</td>
                  <td className="num">{r.fees}</td>
                  <td className="num">{r.executedAt.slice(0, 10)}</td>
                  <td>
                    {!r.voidedAt &&
                      (voiding?.id === r.id ? (
                        <form className="inline-actions" onSubmit={confirmVoid}>
                          <input
                            aria-label={`Why void the ${r.ticker} ${r.side}`}
                            placeholder="reason"
                            value={voiding.reason}
                            onChange={(e) => setVoiding({ id: r.id, reason: e.target.value })}
                            required
                            maxLength={500}
                          />
                          <button type="submit" className="chip">
                            Void
                          </button>
                          <button type="button" className="chip" onClick={() => setVoiding(null)}>
                            Cancel
                          </button>
                        </form>
                      ) : (
                        <button type="button" className="chip" onClick={() => setVoiding({ id: r.id, reason: "" })}>
                          Void…
                        </button>
                      ))}
                  </td>
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
