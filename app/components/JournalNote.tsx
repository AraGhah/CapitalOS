"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

// The decisions the desk cannot see for itself — why a position was sized the
// way it was, why an alert was ignored — written down while they are fresh.
export function JournalNote() {
  const router = useRouter();
  const [form, setForm] = useState({ ticker: "", title: "", detail: "" });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const res = await fetch("/api/journal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    setSaving(false);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? "the note was not saved");
      return;
    }
    setForm({ ticker: "", title: "", detail: "" });
    router.refresh();
  }

  return (
    <form className="panel-body stack-sm" onSubmit={submit}>
      <div className="field-row">
        <label className="field">
          Ticker (optional)
          <input
            value={form.ticker}
            onChange={(e) => setForm({ ...form, ticker: e.target.value.toUpperCase() })}
            spellCheck={false}
          />
        </label>
        <label className="field">
          Decision
          <input
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            placeholder="Trimmed NVDA to 10% after the committee flagged valuation"
            required
          />
        </label>
      </div>
      <label className="field">
        Reasoning
        <textarea value={form.detail} onChange={(e) => setForm({ ...form, detail: e.target.value })} />
      </label>
      <div className="inline-actions">
        <button className="primary" type="submit" disabled={saving || !form.title.trim()}>
          {saving ? "Saving…" : "Add to the journal"}
        </button>
        {error && <span className="down">{error}</span>}
      </div>
    </form>
  );
}
