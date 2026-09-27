import { pool } from "./db";
import { complete, hasModel, NoModelError, type Message, type Tool } from "./llm";
import { scoutFeeds } from "./feeds";
import { resolveCompany } from "./resolve";
import { analyst, dossierHash, scout, strategist } from "./agents";
import { addToWatchlist } from "./company";
import { getCachedDossier, saveDossier, type Dossier } from "./dossier";
import { fetchChart } from "./quote";

/* ---------------------------------------------------------------------------
   Ask the desk.

   The assistant has no financial knowledge in its prompt. It has three tools and
   an instruction to say which one an answer came from, which is the only reason
   to believe anything it says.
--------------------------------------------------------------------------- */

const SYSTEM = `You are the assistant on one person's private investment research desk.

You know nothing about any company except what your tools return. You have no memory of
market history, prices, or earnings. Every factual claim in your answer must come from a
tool result in this conversation.

Rules:
- Call a tool before answering anything about a company, a ticker, or the news.
- Name the source of each claim: the outlet for a headline, "the desk pipeline" for a verdict.
- If the tools return nothing useful, say so. Never fill the gap from memory.
- Never state a price, a target, or a figure that is not in a tool result.
- No disclaimers, no "as an AI", no hedging filler. Be short and concrete.
- A verdict from research_ticker is a summary of public news, not advice. Do not oversell it.`;

const TOOLS: Tool[] = [
  {
    name: "get_news",
    description:
      "Fetch current headlines about any company, ticker or topic from five public news feeds. " +
      "Returns headlines with their outlet and date. Use this for questions about what is happening.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "A company name, ticker, or topic" },
      },
      required: ["query"],
    },
  },
  {
    name: "research_ticker",
    description:
      "Run the full desk pipeline on a ticker: gather headlines, label their sentiment, and issue a " +
      "verdict with a brief. Adds the ticker to the watchlist. Slower than get_news — use it when the " +
      "person asks for a view, a verdict, or an analysis rather than just the news.",
    input_schema: {
      type: "object",
      properties: {
        ticker: { type: "string", description: "The ticker symbol, e.g. MSFT" },
      },
      required: ["ticker"],
    },
  },
  {
    name: "get_quote",
    description:
      "Get the current price, previous close and one-month daily history for a ticker from Yahoo Finance.",
    input_schema: {
      type: "object",
      properties: {
        ticker: { type: "string", description: "The ticker symbol, e.g. MSFT" },
      },
      required: ["ticker"],
    },
  },
];

export interface ToolCallRecord {
  name: string;
  input: Record<string, unknown>;
  summary: string;
}

/* ------------------------------------------------------------------- the tools */

async function runGetNews(query: string): Promise<{ result: unknown; summary: string }> {
  const feeds = await scoutFeeds(query, query);
  const articles = feeds
    .flatMap((f) => f.articles.map((a) => ({ ...a, feed: f.label })))
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
    .slice(0, 30);

  return {
    result: {
      query,
      feeds: feeds.map((f) => ({ feed: f.label, count: f.articles.length, error: f.error })),
      headlines: articles.map((a) => ({
        title: a.title,
        outlet: a.domain,
        when: a.publishedAt.slice(0, 10),
        url: a.url,
      })),
    },
    summary: `${articles.length} headlines for "${query}" from ${
      feeds.filter((f) => f.articles.length > 0).length
    } of 5 feeds`,
  };
}

async function runResearchTicker(ticker: string): Promise<{ result: unknown; summary: string }> {
  const company = await resolveCompany(ticker);
  await addToWatchlist(company.id, null);

  const scouted = await scout(company);
  const analysed = await analyst(company);
  const hash = dossierHash(company, analysed.headlines);

  let dossier: Dossier | null = await getCachedDossier(company.id, hash);

  if (!dossier) {
    const call = await strategist(company, analysed.headlines, analysed.sentiment);
    await saveDossier({
      companyId: company.id,
      inputHash: hash,
      headlineIds: analysed.headlines.map((h) => h.id),
      verdict: call.verdict,
      confidence: call.confidence,
      risk: call.risk,
      horizon: call.horizon,
      brief: call.brief,
      bull: call.bull,
      bear: call.bear,
      catalysts: call.catalysts,
      sentiment: analysed.sentiment,
      feeds: scouted.feeds,
      provider: call.provider,
    });
    dossier = await getCachedDossier(company.id, hash);
  }

  return {
    result: {
      ticker: company.ticker,
      name: company.name,
      added_to_watchlist: true,
      verdict: dossier?.verdict ?? null,
      confidence: dossier?.confidence ?? null,
      risk: dossier?.risk ?? null,
      horizon: dossier?.horizon ?? null,
      brief: dossier?.brief ?? null,
      bull: dossier?.bull ?? [],
      bear: dossier?.bear ?? [],
      catalysts: dossier?.catalysts ?? [],
      sentiment: dossier?.sentiment ?? null,
      headlines_read: dossier?.headlineCount ?? 0,
      produced_by: dossier?.provider ?? null,
    },
    summary: `${company.ticker}: ${dossier?.verdict ?? "no verdict"} from ${
      dossier?.headlineCount ?? 0
    } headlines`,
  };
}

async function runGetQuote(ticker: string): Promise<{ result: unknown; summary: string }> {
  const chart = await fetchChart(ticker, "1mo");
  return {
    result: {
      ticker: chart.ticker,
      currency: chart.currency,
      price: chart.price,
      previous_close: chart.previousClose,
      change_pct: chart.changePct,
      // The model gets the closes, not the whole bar set: it has no use for
      // intraday highs and a shorter payload keeps the call cheap.
      one_month_closes: chart.bars.map((b) => ({ date: b.date, close: b.close })),
    },
    summary: `${chart.ticker} at ${chart.price ?? "unknown"}${
      chart.changePct === null ? "" : ` (${chart.changePct.toFixed(2)}%)`
    }`,
  };
}

async function runTool(
  name: string,
  input: Record<string, unknown>
): Promise<{ result: unknown; summary: string }> {
  try {
    if (name === "get_news") return await runGetNews(String(input.query ?? ""));
    if (name === "research_ticker") return await runResearchTicker(String(input.ticker ?? ""));
    if (name === "get_quote") return await runGetQuote(String(input.ticker ?? ""));
    return { result: { error: `no tool named ${name}` }, summary: `unknown tool ${name}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A failed tool comes back as a result the model can talk about, not an
    // exception that loses the whole conversation.
    return { result: { error: message }, summary: `${name} failed: ${message}` };
  }
}

/* -------------------------------------------------------------------- the loop */

const MAX_TURNS = 6;

export interface ChatTurn {
  reply: string;
  toolCalls: ToolCallRecord[];
}

export async function ask(question: string, history: Message[]): Promise<ChatTurn> {
  if (!hasModel()) throw new NoModelError();

  const messages: Message[] = [...history, { role: "user", content: question }];
  const toolCalls: ToolCallRecord[] = [];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const reply = await complete({
      system: SYSTEM,
      messages,
      tools: TOOLS,
      maxTokens: 2048,
      });

    if (reply.toolUses.length === 0) {
      return { reply: reply.text || "I could not find anything to answer that with.", toolCalls };
    }

    messages.push({ role: "assistant", content: reply.raw });

    const results = [];
    for (const use of reply.toolUses) {
      const { result, summary } = await runTool(use.name, use.input);
      toolCalls.push({ name: use.name, input: use.input, summary });
      results.push({
        type: "tool_result",
        tool_use_id: use.id,
        content: JSON.stringify(result),
      });
    }

    messages.push({ role: "user", content: results });
  }

  return {
    reply: "I kept reaching for more tools without settling on an answer — try a narrower question.",
    toolCalls,
  };
}

/* ------------------------------------------------------------------ transcript */

export interface StoredMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  toolCalls: ToolCallRecord[];
  createdAt: string;
}

export async function loadTranscript(limit = 40): Promise<StoredMessage[]> {
  const { rows } = await pool.query(
    `SELECT id, role, content, tool_calls, created_at
     FROM chat_messages ORDER BY id DESC LIMIT $1`,
    [limit]
  );

  return rows.reverse().map((r) => ({
    id: String(r.id),
    role: r.role,
    content: r.content,
    toolCalls: (r.tool_calls as ToolCallRecord[]) ?? [],
    createdAt: (r.created_at as Date).toISOString(),
  }));
}

export async function saveMessage(
  role: "user" | "assistant",
  content: string,
  toolCalls: ToolCallRecord[] = []
): Promise<void> {
  await pool.query(
    `INSERT INTO chat_messages (role, content, tool_calls) VALUES ($1, $2, $3)`,
    [role, content, JSON.stringify(toolCalls)]
  );
}

export async function clearTranscript(): Promise<void> {
  await pool.query(`DELETE FROM chat_messages`);
}

// Only the text of each turn goes back to the model. Replaying old tool_use
// blocks without their results would be an invalid conversation.
export function toHistory(stored: StoredMessage[]): Message[] {
  return stored.map((m) => ({ role: m.role, content: m.content }));
}
