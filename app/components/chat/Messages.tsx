"use client";

import { memo } from "react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import {
  describeInput,
  toolLabel,
  visibleWhileStreaming,
  type QuoteChartData,
  type StoredMessage,
  type ToolCallRecord,
} from "@/lib/chat-format";
import { CopyButton } from "./CopyButton";
import { Markdown } from "./Markdown";
import { ModelInfo } from "./ModelInfo";

function timeOf(iso: string | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function Avatar() {
  return (
    <span className="msg-avatar" aria-hidden="true">
      C
    </span>
  );
}

/* --------------------------------------------------------------- the person */

export const UserMessage = memo(function UserMessage({ message }: { message: StoredMessage }) {
  const time = timeOf(message.createdAt);
  return (
    <article className="msg msg-user" aria-label="Your question">
      <div className="msg-user-bubble">{message.content}</div>
      {time && <time className="msg-time">{time}</time>}
    </article>
  );
});

/* ----------------------------------------------------------- the tool trace */

function StepIcon({ state }: { state: "running" | "done" | "failed" }) {
  if (state === "running") return <span className="step-spinner" aria-label="running" />;
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-label={state === "failed" ? "failed" : "done"} className={`step-icon ${state}`}>
      {state === "failed" ? (
        <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      ) : (
        <path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      )}
    </svg>
  );
}

// What the copilot actually fetched — the reason to believe the answer.
function ToolTrace({ calls }: { calls: ToolCallRecord[] }) {
  if (calls.length === 0) return null;
  return (
    <details className="msg-steps">
      <summary>
        <span>
          {calls.length} {calls.length === 1 ? "tool" : "tools"} used
        </span>
        <span className="msg-steps-names">{[...new Set(calls.map((c) => toolLabel(c.name)))].join(" · ")}</span>
      </summary>
      <ol>
        {calls.map((call, i) => (
          <li key={i} className={call.failed ? "failed" : undefined}>
            <StepIcon state={call.failed ? "failed" : "done"} />
            <div>
              <strong>{toolLabel(call.name)}</strong>
              <span className="step-summary">{call.summary}</span>
              {Object.keys(call.input).length > 0 && <span className="step-input">{describeInput(call.input)}</span>}
            </div>
          </li>
        ))}
      </ol>
    </details>
  );
}

function QuoteChart({ chart }: { chart: QuoteChartData }) {
  const first = chart.points[0].close;
  const last = chart.points[chart.points.length - 1].close;
  const change = first ? (last - first) / first : null;
  return (
    <figure className="msg-chart">
      <figcaption>
        <strong>{chart.ticker}</strong>
        <span className="subtle">one month of daily closes{chart.currency ? `, ${chart.currency}` : ""}</span>
        {change !== null && (
          <span className={`num ${change >= 0 ? "up" : "down"}`}>
            {change >= 0 ? "+" : ""}
            {(change * 100).toFixed(1)}%
          </span>
        )}
      </figcaption>
      <ResponsiveContainer width="100%" height={180}>
        <LineChart data={chart.points} margin={{ top: 4, right: 4, bottom: 0, left: -12 }}>
          <CartesianGrid stroke="var(--border)" strokeDasharray="2 4" vertical={false} />
          <XAxis dataKey="date" tick={{ fontSize: 11, fill: "var(--faint)" }} stroke="var(--border)" minTickGap={48} />
          <YAxis
            tick={{ fontSize: 11, fill: "var(--faint)" }}
            stroke="var(--border)"
            width={52}
            // scaled to the closes, not to zero, so a month's move is visible
            domain={[(min: number) => min * 0.98, (max: number) => max * 1.02]}
            tickFormatter={(v: number) => v.toFixed(v >= 100 ? 0 : 2)}
          />
          <Tooltip
            contentStyle={{
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              fontSize: 12,
              boxShadow: "var(--shadow-lift)",
            }}
            labelStyle={{ color: "var(--muted)" }}
            itemStyle={{ color: "var(--text)" }}
            formatter={(value) => [typeof value === "number" ? value.toFixed(2) : String(value), "Close"]}
          />
          <Line
            type="monotone"
            dataKey="close"
            stroke={last >= first ? "var(--up)" : "var(--down)"}
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
      <p className="msg-chart-source">Data from the desk&apos;s market-data provider (get_quote), not written by the model.</p>
    </figure>
  );
}

/* --------------------------------------------------------------- an answer */

export const AssistantMessage = memo(function AssistantMessage({
  message,
  latest,
  busy,
  onRegenerate,
  onFollowup,
}: {
  message: StoredMessage;
  latest: boolean;
  busy: boolean;
  onRegenerate: () => void;
  onFollowup: (question: string) => void;
}) {
  const time = timeOf(message.createdAt);
  const charts = message.toolCalls.filter((c) => c.chart).map((c) => c.chart!);
  const followups = latest ? (message.meta.followups ?? []) : [];

  return (
    <article className="msg msg-desk" aria-label="Answer from Capital Copilot">
      <header className="msg-head">
        <Avatar />
        <span className="msg-name">Capital Copilot</span>
        {time && <time className="msg-time">{time}</time>}
      </header>

      <div className="msg-body">
        <Markdown text={message.content} />

        {message.meta.truncated && (
          <p className="msg-note warn">This answer reached its length limit and may stop mid-thought. Ask a narrower question for the rest.</p>
        )}

        {charts.map((chart, i) => (
          <QuoteChart key={i} chart={chart} />
        ))}

        <ToolTrace calls={message.toolCalls} />
        <ModelInfo models={message.meta.models} />

        <div className="msg-actions">
          <CopyButton text={message.content} label="Copy answer" />
          {latest && (
            <button type="button" className="chat-action" onClick={onRegenerate} disabled={busy}>
              <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
                <path d="M13 8a5 5 0 1 1-1.6-3.7M13 3v3h-3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span>Regenerate</span>
            </button>
          )}
        </div>

        {followups.length > 0 && !busy && (
          <div className="followups" role="group" aria-label="Suggested follow-up questions">
            {followups.map((q) => (
              <button key={q} type="button" className="followup" onClick={() => onFollowup(q)}>
                {q}
              </button>
            ))}
          </div>
        )}
      </div>
    </article>
  );
});

/* ------------------------------------------------- an answer being written */

export interface LiveTool {
  name: string;
  input: Record<string, unknown>;
  call?: ToolCallRecord;
}

export function LiveMessage({ content, tools }: { content: string; tools: LiveTool[] }) {
  const visible = visibleWhileStreaming(content);
  const working = tools.some((t) => !t.call);

  return (
    <article className="msg msg-desk msg-live" aria-label="Answer being written" aria-busy="true">
      <header className="msg-head">
        <Avatar />
        <span className="msg-name">Capital Copilot</span>
        <span className="msg-status">{visible ? "writing" : working ? "gathering data" : "thinking"}</span>
      </header>

      <div className="msg-body">
        {tools.length > 0 && (
          <ol className="live-steps">
            {tools.map((t, i) => (
              <li key={i}>
                <StepIcon state={!t.call ? "running" : t.call.failed ? "failed" : "done"} />
                <span>{t.call ? toolLabel(t.name) : `${toolLabel(t.name, true)}…`}</span>
                {t.call && <span className="step-summary">{t.call.summary}</span>}
              </li>
            ))}
          </ol>
        )}

        {visible ? (
          <div className="streaming">
            <Markdown text={visible} />
          </div>
        ) : (
          !working && (
            <div className="typing-dots" aria-label="Thinking">
              <span />
              <span />
              <span />
            </div>
          )
        )}
      </div>
    </article>
  );
}
