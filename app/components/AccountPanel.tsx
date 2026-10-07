"use client";

import { useEffect, useState, type FormEvent } from "react";
import { request } from "@/app/components/request";

interface Account {
  account: { id: string; name: string; baseCurrency: string; tracksCash: boolean };
  valuation: {
    baseCurrency: string;
    totalValue: string;
    cash: Array<{ currency: string; amount: string; amountBase: string }>;
    timeWeightedReturn: { cumulative: number; annualized: number | null };
    moneyWeightedReturn: number | null;
    dividendIncome: string;
    netContributions: string;
    warnings: string[];
  };
}

interface CashRow {
  id: string;
  kind: string;
  amount: string;
  currency: string;
  occurredAt: string;
  ticker: string | null;
  note: string | null;
  voidedAt: string | null;
}

const CURRENCIES = ["USD", "CAD", "EUR", "GBP", "JPY", "AUD", "CHF"];
const pct = (x: number | null) => (x === null ? "—" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}%`);

async function fetchAccount(): Promise<[Account | null, CashRow[]]> {
  const [a, c] = await Promise.all([request("/api/account"), request("/api/cash")]);
  return [a.ok ? await a.json() : null, c.ok ? await c.json() : []];
}

// The account's settings, its valuation summary and its cash ledger:
// deposits, withdrawals, dividends, interest, fees and tax.
export function AccountPanel() {
  const [data, setData] = useState<Account | null>(null);
  const [rows, setRows] = useState<CashRow[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [form, setForm] = useState({
    kind: "deposit",
    amount: "",
    currency: "USD",
    occurredAt: new Date().toLocaleDateString("en-CA"),
    ticker: "",
    note: "",
  });

  async function load() {
    const [a, c] = await fetchAccount();
    setData(a);
    setRows(c);
  }

  useEffect(() => {
    fetchAccount().then(([a, c]) => {
      setData(a);
      setRows(c);
    });
  }, []);

  async function patch(body: Record<string, unknown>) {
    const res = await request("/api/account", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const out = await res.json().catch(() => ({}));
    setStatus(res.ok ? "account updated" : (out.error ?? "the change was refused"));
    await load();
  }

  async function addCash(e: FormEvent) {
    e.preventDefault();
    const res = await request("/api/cash", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: form.kind,
        amount: form.amount,
        currency: form.currency,
        occurredAt: form.occurredAt,
        ticker: form.ticker || undefined,
        note: form.note || undefined,
        idempotencyKey: key,
      }),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) {
      setStatus(out.error ?? "the movement was refused");
      return;
    }
    setKey(crypto.randomUUID());
    setForm((f) => ({ ...f, amount: "", note: "", ticker: "" }));
    setStatus("recorded");
    await load();
  }

  async function voidRow(id: string) {
    const reason = window.prompt("Why void this movement? (kept on record, marked void)");
    if (!reason) return;
    const res = await request(`/api/cash/${id}/void`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason }),
    });
    const out = await res.json().catch(() => ({}));
    setStatus(res.ok ? "voided" : (out.error ?? "the void was refused"));
    await load();
  }

  const v = data?.valuation;
  return (
    <section className="panel" style={{ marginBottom: "1rem" }} aria-labelledby="account-title">
      <div className="panel-head">
        <h2 id="account-title">Account</h2>
        <span className="hint">returns exclude money moving in and out</span>
      </div>
      <div className="panel-body stack-sm">
        {data && (
          <div className="inline-actions">
            <label>
              Report in{" "}
              <select value={data.account.baseCurrency} onChange={(e) => void patch({ baseCurrency: e.target.value })}>
                {CURRENCIES.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
            <label title="Value the account as positions plus cash, with returns measured against deposits and withdrawals">
              <input
                type="checkbox"
                checked={data.account.tracksCash}
                onChange={(e) => void patch({ tracksCash: e.target.checked })}
                style={{ width: "auto" }}
              />{" "}
              track cash
            </label>
          </div>
        )}
        {v && (
          <p className="subtle">
            Value {Number(v.totalValue).toLocaleString(undefined, { maximumFractionDigits: 2 })} {v.baseCurrency} · time-weighted{" "}
            {pct(v.timeWeightedReturn.cumulative)}
            {v.timeWeightedReturn.annualized !== null && ` (${pct(v.timeWeightedReturn.annualized)} a year)`} · money-weighted{" "}
            {pct(v.moneyWeightedReturn)} a year · dividends {Number(v.dividendIncome).toFixed(2)}
            {v.cash.length > 0 && ` · cash ${v.cash.map((c) => `${Number(c.amount).toFixed(2)} ${c.currency}`).join(", ")}`}
          </p>
        )}
        {v?.warnings.map((w) => (
          <p key={w} className="integrity-warning" role="alert">
            {w}
          </p>
        ))}

        <form className="form" onSubmit={addCash} aria-label="Record a cash movement">
          <label>
            Kind
            <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
              {["deposit", "withdrawal", "dividend", "interest", "fee", "tax"].map((k) => (
                <option key={k}>{k}</option>
              ))}
            </select>
          </label>
          <label>
            Amount
            <input type="number" step="any" min="0" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} required />
          </label>
          <label>
            Currency
            <select value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })}>
              {CURRENCIES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
          <label>
            Date
            <input type="date" value={form.occurredAt} onChange={(e) => setForm({ ...form, occurredAt: e.target.value })} required />
          </label>
          {form.kind === "dividend" && (
            <label>
              Paid by
              <input value={form.ticker} onChange={(e) => setForm({ ...form, ticker: e.target.value.toUpperCase() })} required />
            </label>
          )}
          <button className="primary" type="submit">
            Record
          </button>
        </form>
        {status && (
          <p className="subtle" role="status" aria-live="polite">
            {status}
          </p>
        )}

        {rows.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Kind</th>
                <th>Amount</th>
                <th>For</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={r.voidedAt ? "voided" : undefined}>
                  <td className="num">{r.occurredAt.slice(0, 10)}</td>
                  <td>{r.kind}</td>
                  <td className="num">
                    {Number(r.amount).toFixed(2)} {r.currency}
                  </td>
                  <td>{r.ticker ?? ""}</td>
                  <td>
                    {!r.voidedAt && (
                      <button type="button" className="chip" onClick={() => void voidRow(r.id)}>
                        Void…
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
