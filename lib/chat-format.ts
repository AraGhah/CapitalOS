// The copilot's message shapes and the small text helpers both sides need.
// No imports: client components use this file, so it must not pull in the
// database or the model client.

export interface QuoteChartData {
  ticker: string;
  currency: string | null;
  points: Array<{ date: string; close: number }>;
}

export interface ToolCallRecord {
  name: string;
  input: Record<string, unknown>;
  summary: string;
  // set when the tool failed or was refused, so the trace can say so
  failed?: boolean;
  // the closes a quote returned, drawn under the answer — real data, never model text
  chart?: QuoteChartData;
}

// One model's part in an answer. Read from the provider's response (the
// copilot's own calls) or from the model_calls log of the run a tool started —
// never from configuration alone and never from model output.
export interface ModelUse {
  provider: string;
  // null when the provider's response did not name the model
  model: string | null;
  role: string;
  calls: number;
  // calls that returned an error rather than an answer
  failed?: number;
  // true when the work was done by an earlier run whose result was reused
  reused?: boolean;
  // where the identifier came from
  reportedBy: "api-response" | "run-log";
  // a page with the full record, e.g. the committee report
  link?: string;
}

export interface ChatMeta {
  models?: ModelUse[];
  followups?: string[];
  // the final model reply hit its token limit
  truncated?: boolean;
}

export interface StoredMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  toolCalls: ToolCallRecord[];
  meta: ChatMeta;
  createdAt: string;
}

// What the chat endpoint streams, one JSON object per line.
export type ChatEvent =
  | { type: "text"; delta: string }
  // the model is calling tools: the text it wrote so far was preamble
  | { type: "step" }
  | { type: "tool_start"; name: string; input: Record<string, unknown> }
  | { type: "tool_end"; call: ToolCallRecord }
  | { type: "done"; message: StoredMessage }
  | { type: "error"; message: string; requestId?: string };

/* ----------------------------------------------------------------- follow-ups */

// The copilot ends an answer with this marker and a short list of questions.
export const FOLLOWUP_MARKER = "@@followups@@";

// Splits a finished reply into the answer and its suggested follow-ups.
export function splitFollowups(text: string): { body: string; followups: string[] } {
  const at = text.indexOf(FOLLOWUP_MARKER);
  if (at === -1) return { body: text.trim(), followups: [] };
  const followups = text
    .slice(at + FOLLOWUP_MARKER.length)
    .split("\n")
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
    .filter((line) => line.length > 3 && line.length <= 200)
    .slice(0, 4);
  return { body: text.slice(0, at).trim(), followups };
}

// While a reply streams, the marker may have arrived only in part ("@@foll");
// whatever could be the start of it is held back so it never flashes on screen.
export function visibleWhileStreaming(text: string): string {
  const at = text.indexOf(FOLLOWUP_MARKER);
  if (at !== -1) return text.slice(0, at);
  for (let n = Math.min(FOLLOWUP_MARKER.length - 1, text.length); n > 0; n--) {
    if (FOLLOWUP_MARKER.startsWith(text.slice(-n))) return text.slice(0, -n);
  }
  return text;
}

/* ---------------------------------------------------------------- tool labels */

const TOOL_LABELS: Record<string, { done: string; running: string }> = {
  get_news: { done: "Searched the news", running: "Searching the news feeds" },
  research_ticker: { done: "Ran the desk research pipeline", running: "Running the research pipeline" },
  convene_committee: { done: "Convened the investment committee", running: "Convening the investment committee — this can take a few minutes" },
  portfolio_risk: { done: "Measured portfolio risk", running: "Measuring portfolio risk" },
  run_scenario: { done: "Ran a scenario", running: "Running a scenario" },
  market_regime: { done: "Read the market regime", running: "Reading the market" },
  run_screen: { done: "Ran a screen", running: "Screening companies" },
  run_backtest: { done: "Ran a backtest", running: "Running a backtest" },
  paper_portfolio: { done: "Read the paper portfolio", running: "Reading the paper portfolio" },
  get_alerts: { done: "Read the open alerts", running: "Reading the open alerts" },
  get_quote: { done: "Fetched a quote", running: "Fetching a quote" },
};

export function toolLabel(name: string, running = false): string {
  const label = TOOL_LABELS[name];
  if (!label) return name.replace(/_/g, " ");
  return running ? label.running : label.done;
}

// A tool's input as words ("ticker NVDA · mode standard"), not JSON.
export function describeInput(input: Record<string, unknown>): string {
  return Object.entries(input)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => `${k.replace(/_/g, " ")} ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
    .join(" · ");
}

const PROVIDER_NAMES: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  gemini: "Google",
  xai: "xAI",
  mistral: "Mistral",
  deepseek: "DeepSeek",
  openrouter: "OpenRouter",
};

export function providerName(provider: string): string {
  return PROVIDER_NAMES[provider.toLowerCase()] ?? provider;
}
