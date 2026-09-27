"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

interface ToolCall {
  name: string;
  input: Record<string, unknown>;
  summary: string;
}

interface Turn {
  id: string;
  role: "user" | "assistant";
  content: string;
  toolCalls: ToolCall[];
}

// The transcript lives in the database rather than in this component, so a refresh
// keeps the conversation and the tool trace that justifies each answer.
export function AskTheDesk({ initialQuestion }: { initialQuestion?: string }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [question, setQuestion] = useState("");
  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const threadRef = useRef<HTMLDivElement>(null);
  const asked = useRef(false);

  const send = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    setQuestion("");
    setError(null);
    setThinking(true);
    setTurns((t) => [...t, { id: `local-${Date.now()}`, role: "user", content: trimmed, toolCalls: [] }]);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: trimmed }),
      });
      const body = await res.json();

      if (!res.ok) {
        setError(body.error ?? `the desk could not answer (${res.status})`);
        return;
      }

      setTurns((t) => [
        ...t,
        {
          id: `local-${Date.now()}-reply`,
          role: "assistant",
          content: body.reply,
          toolCalls: body.toolCalls ?? [],
        },
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setThinking(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    fetch("/api/chat")
      .then((res) => res.json())
      .then((body: { messages: Turn[] }) => {
        if (cancelled) return;
        setTurns(body.messages ?? []);
        setLoaded(true);

        // A company name typed into the search bar arrives as ?q= and is asked once.
        if (initialQuestion && !asked.current) {
          asked.current = true;
          void send(initialQuestion);
        }
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });

    return () => {
      cancelled = true;
    };
  }, [initialQuestion, send]);

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight, behavior: "smooth" });
  }, [turns, thinking]);

  async function clear() {
    await fetch("/api/chat", { method: "DELETE" });
    setTurns([]);
    setError(null);
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    void send(question);
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Ask the desk</h2>
        {turns.length > 0 && (
          <button type="button" className="linklike" onClick={clear}>
            clear
          </button>
        )}
      </div>

      <div className="thread" ref={threadRef}>
        {!loaded && <p className="subtle">Loading the conversation…</p>}

        {loaded && turns.length === 0 && !thinking && (
          <p className="subtle">
            Ask about any company or ticker. The desk can pull fresh headlines, get a quote, or run
            the full pipeline on a ticker — and it will tell you which it did.
          </p>
        )}

        {turns.map((turn) => (
          <div key={turn.id} className={`bubble ${turn.role === "user" ? "user" : "desk"}`}>
            {turn.content}
            {turn.toolCalls.length > 0 && (
              <div className="trace">
                {turn.toolCalls.map((call, i) => (
                  <span key={i} className="pill info" title={JSON.stringify(call.input)}>
                    {call.name}: {call.summary}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}

        {thinking && (
          <div className="bubble desk">
            <span className="typing">
              <span className="dot" />
              working on it — this can take a moment if it has to fetch news
            </span>
          </div>
        )}

        {error && <p className="alert">{error}</p>}
      </div>

      <form className="composer" onSubmit={submit}>
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="What is going on with NVDA?"
          aria-label="Ask the desk"
          disabled={thinking}
        />
        <button className="primary" type="submit" disabled={thinking || !question.trim()}>
          Ask
        </button>
      </form>
    </section>
  );
}
