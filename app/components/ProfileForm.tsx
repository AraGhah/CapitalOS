"use client";

import { useState, type FormEvent } from "react";
import { request } from "@/app/components/request";
import { ACCOUNT_TYPES, OBJECTIVES, RISK_TOLERANCES, type InvestorProfile } from "@/lib/profile-fields";

const OBJECTIVE_LABELS: Record<string, string> = {
  emergency: "Emergency savings",
  car: "Buying a car (1–3 years)",
  house: "Buying a house (3–7 years)",
  wealth: "Building wealth (10–20 years)",
  retirement: "Retirement (20–40 years)",
  income: "Generating income",
};

const ACCOUNT_LABELS: Record<string, string> = {
  tfsa: "TFSA",
  rrsp: "RRSP",
  fhsa: "FHSA",
  non_registered: "Non-registered",
  other: "Other",
};

type Field = Exclude<keyof InvestorProfile, "updatedAt">;
const MONEY: Field[] = ["monthlyExpenses", "emergencyFund", "highInterestDebt", "investableAmount", "positionSize", "contributionRoom"];
// stored as a share (0.3), typed as a percentage (30)
const PERCENT: Field[] = ["maxLossShare", "tradingCostShare"];

function toText(p: InvestorProfile): Record<Field, string> {
  const out = {} as Record<Field, string>;
  for (const key of Object.keys(p) as Array<keyof InvestorProfile>) {
    if (key === "updatedAt") continue;
    const value = p[key];
    if (value === null) out[key] = "";
    else if (key === "institutionVerified") out[key] = value ? "yes" : "no";
    else if (PERCENT.includes(key)) out[key] = String(Number(((value as number) * 100).toFixed(4)));
    else out[key] = String(value);
  }
  return out;
}

// The investor profile: the questions about the person that come before any
// question about a stock. Blank means unanswered, and the checklist says so.
export function ProfileForm({ initial, currency }: { initial: InvestorProfile; currency: string }) {
  const [text, setText] = useState(() => toText(initial));
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const set = (key: Field) => (e: { target: { value: string } }) => setText((t) => ({ ...t, [key]: e.target.value }));

  async function save(e: FormEvent) {
    e.preventDefault();
    const body: Record<string, unknown> = {};
    for (const key of Object.keys(text) as Field[]) {
      const raw = text[key].trim();
      if (MONEY.includes(key) || PERCENT.includes(key) || key === "horizonYears") {
        if (raw === "") body[key] = null;
        else {
          const n = Number(raw.replace(/[, ]/g, ""));
          if (!Number.isFinite(n)) {
            setStatus(`"${raw}" is not a number`);
            return;
          }
          body[key] = PERCENT.includes(key) ? n / 100 : n;
        }
      } else if (key === "institutionVerified") {
        body[key] = raw === "" ? null : raw === "yes";
      } else {
        body[key] = raw === "" ? null : raw;
      }
    }
    setSaving(true);
    const res = await request("/api/profile", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const out = await res.json().catch(() => ({}));
    setSaving(false);
    if (!res.ok) {
      setStatus(out.error ?? "the profile was not saved");
      return;
    }
    setText(toText(out as InvestorProfile));
    setStatus("saved — every checklist now reads these answers");
  }

  const money = (key: Field, label: string, hint?: string) => (
    <label className="field" title={hint}>
      {label} ({currency})
      <input inputMode="decimal" value={text[key]} onChange={set(key)} placeholder="unanswered" />
    </label>
  );

  return (
    <form onSubmit={save} className="stack">
      <section className="panel">
        <div className="panel-head">
          <h2>Your finances</h2>
          <span className="hint">guide §1A</span>
        </div>
        <div className="panel-body profile-grid">
          {money("monthlyExpenses", "Monthly expenses")}
          {money("emergencyFund", "Accessible emergency savings", "Cash you can reach within days without selling investments")}
          {money("highInterestDebt", "High-interest debt", "Credit cards and other debt at a high rate; 0 if none")}
          {money("investableAmount", "Money available to invest", "New money you can put to work, including the position below")}
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Your goal and risk</h2>
          <span className="hint">guide §1B, §9</span>
        </div>
        <div className="panel-body profile-grid">
          <label className="field">
            What the money is for
            <select value={text.objective} onChange={set("objective")}>
              <option value="">unanswered</option>
              {OBJECTIVES.map((o) => (
                <option key={o} value={o}>
                  {OBJECTIVE_LABELS[o]}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Years until you need it
            <input inputMode="decimal" value={text.horizonYears} onChange={set("horizonYears")} placeholder="unanswered" />
          </label>
          <label className="field" title="Risk capacity: the share of this money you could lose without derailing your goal">
            Share you could afford to lose (%)
            <input inputMode="decimal" value={text.maxLossShare} onChange={set("maxLossShare")} placeholder="e.g. 30" />
          </label>
          <label className="field" title="Risk tolerance: how you would feel watching it fall">
            How you handle declines
            <select value={text.riskTolerance} onChange={set("riskTolerance")}>
              <option value="">unanswered</option>
              {RISK_TOLERANCES.map((r) => (
                <option key={r} value={r}>
                  {r === "low" ? "Low — falls make me want to sell" : r === "medium" ? "Medium" : "High — I can sit through large falls"}
                </option>
              ))}
            </select>
          </label>
          {money("positionSize", "Planned size of one position", "The amount you would put into a single stock")}
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Account, costs and broker</h2>
          <span className="hint">guide §11, §12</span>
        </div>
        <div className="panel-body profile-grid">
          <label className="field">
            Account you would buy in
            <select value={text.accountType} onChange={set("accountType")}>
              <option value="">unanswered</option>
              {ACCOUNT_TYPES.map((a) => (
                <option key={a} value={a}>
                  {ACCOUNT_LABELS[a]}
                </option>
              ))}
            </select>
          </label>
          {money("contributionRoom", "Contribution room left", "From CRA My Account; leave blank for a non-registered account")}
          <label className="field" title="Commission plus any currency-conversion spread, as a percentage of one trade">
            Cost of one trade (%)
            <input inputMode="decimal" value={text.tradingCostShare} onChange={set("tradingCostShare")} placeholder="e.g. 0.5" />
          </label>
          <label className="field">
            Broker
            <input value={text.institution} onChange={set("institution")} placeholder="unanswered" maxLength={120} />
          </label>
          <label className="field" title="Checked on the CSA National Registration Search and CIRO's member list">
            Registration checked?
            <select value={text.institutionVerified} onChange={set("institutionVerified")}>
              <option value="">unanswered</option>
              <option value="yes">Yes — registered (CIRO / CIPF member)</option>
              <option value="no">No, or not registered</option>
            </select>
          </label>
        </div>
      </section>

      <div className="inline-actions">
        <button type="submit" className="primary" disabled={saving}>
          {saving ? "Saving…" : "Save profile"}
        </button>
        {status && (
          <span className="subtle" role="status">
            {status}
          </span>
        )}
      </div>
    </form>
  );
}
