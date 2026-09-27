"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

// A ticker goes straight to its research page. Anything that is not shaped like a
// ticker — a company name, a question — goes to the desk, which has tools for
// looking things up by name.
const TICKER = /^[A-Za-z][A-Za-z0-9.\-]{0,9}$/;

export function TickerSearch() {
  const router = useRouter();
  const [value, setValue] = useState("");

  function submit(e: FormEvent) {
    e.preventDefault();
    const query = value.trim();
    if (!query) return;

    setValue("");

    if (TICKER.test(query)) {
      router.push(`/research/${encodeURIComponent(query.toUpperCase())}`);
    } else {
      router.push(`/ask?q=${encodeURIComponent(query)}`);
    }
  }

  return (
    <form className="search" onSubmit={submit} role="search">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--faint)" strokeWidth="2">
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.5-3.5" strokeLinecap="round" />
      </svg>
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Ticker, or ask a question"
        aria-label="Look up a ticker, or ask the desk a question"
        spellCheck={false}
        autoComplete="off"
      />
    </form>
  );
}
