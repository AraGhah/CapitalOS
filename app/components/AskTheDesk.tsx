"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { ChatEvent, StoredMessage } from "@/lib/chat-format";
import { AssistantMessage, LiveMessage, UserMessage, type LiveTool } from "./chat/Messages";

// Written by the search bar just before it navigates here.
export const PENDING_KEY = "capitalos.pending-question";

const MAX_LENGTH = 4000;

const STARTERS = [
  { title: "A company", question: "What is going on with NVDA right now?" },
  { title: "Your risk", question: "How risky is my portfolio, and what drives that risk?" },
  { title: "The market", question: "What kind of market are we in, and what is driving it?" },
  { title: "A strategy", question: "Backtest companies growing revenue over 20% with positive free cash flow." },
];

interface Live {
  content: string;
  tools: LiveTool[];
}

interface Failure {
  message: string;
  question: string;
}

// The transcript lives in the database rather than in this component, so a
// refresh keeps the conversation, the tool trace behind each answer and the
// models that wrote it.
export function AskTheDesk({ initialQuestion }: { initialQuestion?: string }) {
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [question, setQuestion] = useState("");
  const [live, setLive] = useState<Live | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [pinned, setPinned] = useState(true);

  const threadRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const liveRef = useRef<Live | null>(null);
  const frame = useRef<number | null>(null);
  const busyRef = useRef(false);
  const asked = useRef(false);

  const busy = live !== null;

  // Text arrives a few characters at a time; the screen is updated at most
  // once a frame, not once per fragment.
  const flush = useCallback(() => {
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const current = liveRef.current;
      setLive(current ? { content: current.content, tools: [...current.tools] } : null);
    });
  }, []);

  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    []
  );

  const send = useCallback(
    async (text: string, opts: { regenerate?: boolean } = {}) => {
      const trimmed = text.trim();
      if (!trimmed || busyRef.current) return;
      busyRef.current = true;

      setQuestion("");
      setFailure(null);
      setPinned(true);
      setMessages((list) => {
        let next = list;
        // Regenerating or retrying takes the last exchange off the screen, as
        // the server takes it off the transcript.
        if (opts.regenerate) {
          if (next.at(-1)?.role === "assistant") next = next.slice(0, -1);
          if (next.at(-1)?.role === "user" && next.at(-1)?.content.trim() === trimmed) next = next.slice(0, -1);
        }
        return [
          ...next,
          { id: `local-${Date.now()}`, role: "user", content: trimmed, toolCalls: [], meta: {}, createdAt: new Date().toISOString() },
        ];
      });
      liveRef.current = { content: "", tools: [] };
      setLive({ content: "", tools: [] });

      const fail = (message: string) => {
        setFailure({ message, question: trimmed });
      };

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question: trimmed, ...(opts.regenerate ? { regenerate: true } : {}) }),
        });

        if (!res.ok || !res.body) {
          const body = await res.json().catch(() => null);
          fail(body?.error ?? `The desk could not answer (status ${res.status}).`);
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let finished = false;

        const handle = (event: ChatEvent) => {
          const current = liveRef.current;
          if (!current) return;
          switch (event.type) {
            case "text":
              current.content += event.delta;
              break;
            case "step":
              // the text so far introduced a tool call; the answer comes after
              current.content = "";
              break;
            case "tool_start":
              current.tools.push({ name: event.name, input: event.input });
              break;
            case "tool_end": {
              const slot = current.tools.find((t) => !t.call && t.name === event.call.name);
              if (slot) slot.call = event.call;
              else current.tools.push({ name: event.call.name, input: event.call.input, call: event.call });
              break;
            }
            case "done":
              finished = true;
              setMessages((list) => [...list, event.message]);
              return;
            case "error":
              finished = true;
              fail(event.message);
              return;
          }
          flush();
        };

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let at: number;
          while ((at = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, at).trim();
            buffer = buffer.slice(at + 1);
            if (!line) continue;
            try {
              handle(JSON.parse(line) as ChatEvent);
            } catch {
              // a malformed line is skipped, not fatal
            }
          }
        }
        if (!finished) {
          fail("The connection closed before the answer finished. It may still have been saved — reload the page to check.");
        }
      } catch (err) {
        fail(`Could not reach the desk: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        if (frame.current !== null) {
          cancelAnimationFrame(frame.current);
          frame.current = null;
        }
        liveRef.current = null;
        setLive(null);
        busyRef.current = false;
        inputRef.current?.focus();
      }
    },
    [flush]
  );

  useEffect(() => {
    let cancelled = false;

    fetch("/api/chat")
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (!res.ok) throw new Error(body?.error ?? `status ${res.status}`);
        return body as { messages: StoredMessage[] };
      })
      .then((body) => {
        if (cancelled) return;
        setMessages((body.messages ?? []).map((m) => ({ ...m, meta: m.meta ?? {} })));
        setLoaded(true);

        if (asked.current) return;
        asked.current = true;

        // A question typed into this desk's own search bar is handed over through
        // sessionStorage and asked straight away. One that arrives in the URL only
        // fills the box: a link from anywhere else must not be able to make the
        // copilot spend model calls without the person pressing Ask.
        let pending: string | null = null;
        try {
          pending = sessionStorage.getItem(PENDING_KEY);
          sessionStorage.removeItem(PENDING_KEY);
        } catch {
          pending = null;
        }
        if (pending && pending === initialQuestion) void send(pending);
        else if (initialQuestion) setQuestion(initialQuestion);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setLoadError(`The earlier conversation could not be loaded (${err.message}).`);
        setLoaded(true);
      });

    return () => {
      cancelled = true;
    };
  }, [initialQuestion, send]);

  /* ------------------------------------------------------------ scrolling */

  // The thread follows new text only while the person is at the bottom; once
  // they scroll up to read, it stays where they are.
  const onScroll = useCallback(() => {
    const el = threadRef.current;
    if (!el) return;
    setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
  }, []);

  useLayoutEffect(() => {
    const el = threadRef.current;
    // an empty conversation opens at the top, on the introduction
    if (el && pinned && (messages.length > 0 || live || failure)) el.scrollTop = el.scrollHeight;
  }, [messages, live, failure, pinned]);

  function jumpToLatest() {
    const el = threadRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    setPinned(true);
  }

  /* -------------------------------------------------------------- composer */

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [question]);

  function submit(e: FormEvent) {
    e.preventDefault();
    void send(question);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send(question);
    }
  }

  async function clear() {
    if (!confirmClear) {
      setConfirmClear(true);
      return;
    }
    setConfirmClear(false);
    const res = await fetch("/api/chat", { method: "DELETE" }).catch(() => null);
    if (!res?.ok) {
      setFailure({ message: "The conversation could not be cleared. Try again.", question: "" });
      return;
    }
    setMessages([]);
    setFailure(null);
  }

  // Read through a ref so the callback stays the same and finished answers
  // are not re-rendered on every new message.
  const messagesRef = useRef(messages);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const regenerate = useCallback(() => {
    const lastQuestion = [...messagesRef.current].reverse().find((m) => m.role === "user");
    if (lastQuestion) void send(lastQuestion.content, { regenerate: true });
  }, [send]);

  const followup = useCallback((q: string) => void send(q), [send]);

  const lastAssistant = messages.at(-1)?.role === "assistant" ? messages.at(-1)!.id : null;
  const tooLong = question.length > MAX_LENGTH;

  return (
    <section className="panel chat" aria-label="Capital Copilot conversation">
      <div className="panel-head chat-head">
        <div className="chat-title">
          <h2>Conversation</h2>
          <span className={`chat-state ${busy ? "busy" : ""}`}>
            <span className="chat-state-dot" aria-hidden="true" />
            {busy ? "Working on an answer" : "Ready"}
          </span>
        </div>
        {messages.length > 0 && (
          <div className="chat-head-actions">
            {confirmClear && (
              <button type="button" className="chat-action" onClick={() => setConfirmClear(false)}>
                Keep it
              </button>
            )}
            <button
              type="button"
              className={`chat-action ${confirmClear ? "danger" : ""}`}
              onClick={clear}
              disabled={busy}
              onBlur={() => setTimeout(() => setConfirmClear(false), 150)}
            >
              {confirmClear ? "Delete the whole conversation" : "Clear"}
            </button>
          </div>
        )}
      </div>

      <div className="chat-thread" ref={threadRef} onScroll={onScroll} role="log" aria-live="polite" aria-relevant="additions">
        <div className="chat-column">
          {!loaded && (
            <div className="chat-loading" aria-label="Loading the conversation">
              <span className="skeleton" />
              <span className="skeleton short" />
              <span className="skeleton" />
            </div>
          )}

          {loadError && <p className="alert">{loadError}</p>}

          {loaded && messages.length === 0 && !busy && (
            <div className="chat-empty">
              <span className="msg-avatar large" aria-hidden="true">
                C
              </span>
              <h3>Ask the desk anything about your investments</h3>
              <p>
                The copilot answers from the desk&apos;s own tools — live news, quotes, the research pipeline, portfolio
                risk, screens, backtests and the multi-model investment committee — and shows which tools and which
                AI models produced every answer.
              </p>
              <div className="starters">
                {STARTERS.map((s) => (
                  <button key={s.question} type="button" className="starter" onClick={() => void send(s.question)}>
                    <span className="starter-title">{s.title}</span>
                    <span>{s.question}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((m) =>
            m.role === "user" ? (
              <UserMessage key={m.id} message={m} />
            ) : (
              <AssistantMessage
                key={m.id}
                message={m}
                latest={m.id === lastAssistant}
                busy={busy}
                onRegenerate={regenerate}
                onFollowup={followup}
              />
            )
          )}

          {live && <LiveMessage content={live.content} tools={live.tools} />}

          {failure && (
            <div className="chat-error" role="alert">
              <div>
                <strong>The answer did not come through.</strong>
                <p>{failure.message}</p>
              </div>
              {failure.question && (
                <button type="button" className="chat-action" onClick={() => void send(failure.question, { regenerate: true })} disabled={busy}>
                  Try again
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {!pinned && (messages.length > 0 || busy) && (
        <button type="button" className="jump-latest" onClick={jumpToLatest}>
          ↓ Latest
        </button>
      )}

      <form className="chat-composer" onSubmit={submit}>
        <div className={`composer-box ${tooLong ? "invalid" : ""}`}>
          <textarea
            ref={inputRef}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Ask about a company, your portfolio, the market or a strategy…"
            aria-label="Ask the desk"
            rows={1}
            disabled={busy}
          />
          <button className="send" type="submit" disabled={busy || !question.trim() || tooLong} aria-label="Send question">
            {busy ? (
              <span className="step-spinner" aria-hidden="true" />
            ) : (
              <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
                <path d="M8 13V3M3.5 7.5L8 3l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </button>
        </div>
        <div className="composer-hint">
          <span>Enter to send · Shift+Enter for a new line</span>
          {question.length > MAX_LENGTH - 500 && (
            <span className={tooLong ? "down" : ""}>
              {question.length} / {MAX_LENGTH}
            </span>
          )}
        </div>
      </form>
    </section>
  );
}
