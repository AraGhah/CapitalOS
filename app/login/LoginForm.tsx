"use client";

import { useState, type FormEvent } from "react";
import { request } from "@/app/components/request";

type Mode = "signin" | "claim" | "signup";

export function LoginForm({ next, claimable, signup }: { next: string; claimable: boolean; signup: boolean }) {
  const [mode, setMode] = useState<Mode>(claimable ? "claim" : "signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [setupCode, setSetupCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const path = mode === "claim" ? "/api/auth/claim" : mode === "signup" ? "/api/auth/signup" : "/api/auth/login";
    const res = await request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, ...(mode === "claim" && setupCode ? { setupCode } : {}) }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? "that did not work");
      setBusy(false);
      return;
    }
    window.location.assign(next);
  }

  const title = mode === "claim" ? "Set up your desk" : mode === "signup" ? "Create an account" : "Sign in";

  return (
    <section className="panel auth-card" aria-labelledby="auth-title">
      <div className="panel-head">
        <h1 id="auth-title">{title}</h1>
        <span className="hint">Capital OS</span>
      </div>
      <form className="panel-body form" onSubmit={submit}>
        {mode === "claim" && (
          <p className="subtle">
            This desk has data but no owner yet. Choose the e-mail and password that will own it. From a
            machine other than the server you will also need the setup code printed by{" "}
            <code>npm run user -- setup-code</code>.
          </p>
        )}
        <label>
          E-mail
          <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label>
          Password
          <input
            type="password"
            autoComplete={mode === "signin" ? "current-password" : "new-password"}
            minLength={mode === "signin" ? 1 : 12}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        {mode === "claim" && (
          <label>
            Setup code <span className="hint">(only when not on the server itself)</span>
            <input value={setupCode} onChange={(e) => setSetupCode(e.target.value)} autoComplete="off" />
          </label>
        )}
        {error && (
          <p className="integrity-warning" role="alert">
            {error}
          </p>
        )}
        <div className="inline-actions">
          <button type="submit" disabled={busy}>
            {busy ? "Working…" : title}
          </button>
          {mode !== "signin" && (
            <button type="button" className="chip" onClick={() => setMode("signin")}>
              I already have an account
            </button>
          )}
          {mode === "signin" && signup && (
            <button type="button" className="chip" onClick={() => setMode("signup")}>
              Create an account
            </button>
          )}
          {mode === "signin" && claimable && (
            <button type="button" className="chip" onClick={() => setMode("claim")}>
              Set up this desk
            </button>
          )}
        </div>
      </form>
    </section>
  );
}
