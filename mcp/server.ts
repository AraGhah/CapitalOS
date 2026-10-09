import "./stderr";
import "../lib/env";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type Decimal from "decimal.js";
import { BENCHMARK_TICKER } from "../lib/constants";
import type { Actor } from "../lib/actor";
import { config } from "../lib/config";
import { findUserByEmail } from "../lib/auth/users";
import { ensureAccount } from "../lib/auth/sessions";
import { listTransactions } from "../lib/ledger";
import { log } from "../lib/log";
import { getPortfolio } from "../lib/holdings";
import { getPortfolioSeries } from "../lib/timeseries";
import { getScores } from "../lib/scoring";
import { buildChecklist } from "../lib/checklist-data";
import { SECTION_NAMES, getFilingSection } from "../lib/filing-text";
import { RESEARCH_FIELDS, addClaims, getResearchNote, type ResearchField } from "../lib/research";
import { registerFilingSource } from "../lib/sources";
import { getEvents } from "../lib/news";
import { RULE_METRICS, listTheses, openThesis, parseRules, setThesisStatus } from "../lib/theses";
import {
  companySource,
  findCompany,
  getFilings,
  getFundamentals,
  getMacroSeries,
  getPriceHistory,
  getWatchlist,
  addToWatchlist,
  removeFromWatchlist,
  listMacroSeriesIds,
  type CompanyRow,
  type ToolSource,
} from "../lib/company";

const server = new McpServer({ name: "capitalos", version: "1.0.0" });

// The MCP server acts for exactly one person, named in its configuration. A
// tool never takes an account or a user from the caller: whoever can talk to
// this process can only ever see that person's data.
let actor!: Pick<Actor, "userId" | "accountId">;

async function resolveActor(): Promise<Pick<Actor, "userId" | "accountId">> {
  const email = config().CAPITALOS_MCP_USER;
  if (!email) throw new Error("set CAPITALOS_MCP_USER to the e-mail of the account the MCP server acts for");
  const user = await findUserByEmail(email);
  if (!user) throw new Error(`no account with the e-mail ${email}`);
  const account = await ensureAccount(user.id);
  return { userId: user.id, accountId: account.id };
}

const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date like 2026-10-05");

// Tools hand back stored values and the rows they came from. Interpretation is
// the caller's job, which is why nothing here returns prose.
function reply(data: unknown, sources: ToolSource[]) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ data, sources }, null, 2) }],
  };
}

function failed(message: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

async function resolve(ticker: string): Promise<CompanyRow | string> {
  const company = await findCompany(ticker);
  return company ?? `no company stored for ticker "${ticker}"`;
}

const money = (d: Decimal) => d.toFixed(2);

server.registerTool(
  "portfolio_positions",
  {
    title: "Portfolio positions",
    description:
      "Open positions with quantity, average cost, market value, weight and unrealized P/L.",
    inputSchema: {},
  },
  async () => {
    const { holdings } = await getPortfolio(actor.accountId);
    return reply(
      holdings.map((h) => ({
        ticker: h.ticker,
        name: h.name,
        qty: h.qty.toString(),
        avgCost: money(h.avgCost),
        price: money(h.price),
        costBasis: money(h.costBasis),
        marketValue: money(h.marketValue),
        unrealizedPL: money(h.unrealizedPL),
        realizedPL: money(h.realizedPL),
        weight: h.weight.toFixed(4),
      })),
      [
        { kind: "transactions", ref: actor.accountId },
        { kind: "prices_daily", ref: "latest close per company" },
      ]
    );
  }
);

server.registerTool(
  "portfolio_performance",
  {
    title: "Portfolio performance",
    description:
      "Total return against the benchmark, both indexed to 100 at the first comparable date.",
    inputSchema: { includeSeries: z.boolean().optional() },
  },
  async ({ includeSeries }) => {
    const account = actor.accountId;
    const [{ totalReturn }, series] = await Promise.all([
      getPortfolio(account),
      getPortfolioSeries(account),
    ]);

    const last = series.at(-1);
    return reply(
      {
        totalReturn: totalReturn.toFixed(6),
        benchmark: BENCHMARK_TICKER,
        start: series[0]?.date ?? null,
        end: last?.date ?? null,
        portfolioIndex: last?.portfolioIndex ?? null,
        benchmarkIndex: last?.benchmarkIndex ?? null,
        differenceVsBenchmark: last
          ? Number((last.portfolioIndex - last.benchmarkIndex).toFixed(4))
          : null,
        series: includeSeries ? series : undefined,
      },
      [
        { kind: "transactions", ref: account },
        { kind: "prices_daily", ref: `holdings and ${BENCHMARK_TICKER}` },
      ]
    );
  }
);

server.registerTool(
  "portfolio_transactions",
  {
    title: "Portfolio transactions",
    description: "Recorded buys and sells, most recent first.",
    inputSchema: {
      ticker: z.string().optional(),
      limit: z.number().int().min(1).max(500).optional(),
    },
  },
  async ({ ticker, limit }) => {
    const rows = await listTransactions(actor, { ticker, limit });
    return reply(rows, [{ kind: "transactions", ref: actor.accountId }]);
  }
);

server.registerTool(
  "pre_investment_check",
  {
    title: "Pre-investment checklist",
    description:
      "Every question to answer before buying a stock, computed against the person's investor profile: readiness, " +
      "savings, objective, horizon and risk capacity; the business, its cash and debt; valuation scenarios; macro; " +
      "diversification, currency, liquidity; fees, taxes and broker safety; exit plan and downside. Run it before " +
      "suggesting any purchase. Each item is pass, caution, fail, missing (no data) or input (only the person can answer).",
    inputSchema: { ticker: z.string(), positionSize: z.number().min(0).optional() },
  },
  async ({ ticker, positionSize }) => {
    const company = await resolve(ticker);
    if (typeof company === "string") return failed(company);
    const checklist = await buildChecklist(actor, company.ticker, { positionSize });
    return reply(checklist, [companySource(company), { kind: "filing", ref: "annual XBRL facts" }, { kind: "prices_daily", ref: "one year of daily closes" }]);
  }
);

server.registerTool(
  "company_profile",
  {
    title: "Company profile",
    description: "Stored identity for a ticker: name, CIK, sector and industry.",
    inputSchema: { ticker: z.string() },
  },
  async ({ ticker }) => {
    const company = await resolve(ticker);
    if (typeof company === "string") return failed(company);
    return reply(company, [companySource(company)]);
  }
);

server.registerTool(
  "company_fundamentals",
  {
    title: "Company fundamentals",
    description:
      "Reported figures per metric and period, each carrying the filing it came from. Values are as most recently restated.",
    inputSchema: {
      ticker: z.string(),
      metrics: z.array(z.string()).optional(),
      fiscalPeriod: z.enum(["FY", "Q"]).optional(),
      periods: z.number().int().min(1).max(20).optional(),
    },
  },
  async ({ ticker, metrics, fiscalPeriod, periods }) => {
    const company = await resolve(ticker);
    if (typeof company === "string") return failed(company);

    const { rows, sources } = await getFundamentals(company.id, {
      metrics,
      fiscalPeriod: fiscalPeriod ?? "FY",
      periods,
    });
    return reply(rows, [companySource(company), ...sources]);
  }
);

server.registerTool(
  "company_score",
  {
    title: "Company score",
    description:
      "Latest weighted score with every component: raw value, sector percentile, weight and contribution.",
    inputSchema: { ticker: z.string() },
  },
  async ({ ticker }) => {
    const company = await resolve(ticker);
    if (typeof company === "string") return failed(company);

    const score = (await getScores()).find((s) => s.companyId === company.id);
    if (!score) return failed(`no score stored for ${company.ticker}; run compute-scores first`);

    return reply(score, [companySource(company), { kind: "scores", ref: `as_of ${score.asOf}` }]);
  }
);

server.registerTool(
  "price_history",
  {
    title: "Price history",
    description: "Daily bars for a ticker, oldest first.",
    inputSchema: {
      ticker: z.string(),
      start: ISO_DATE.optional(),
      end: ISO_DATE.optional(),
      limit: z.number().int().min(1).max(2000).optional(),
    },
  },
  async ({ ticker, start, end, limit }) => {
    const company = await resolve(ticker);
    if (typeof company === "string") return failed(company);

    const bars = await getPriceHistory(company.id, { start, end, limit });
    return reply(bars, [
      companySource(company),
      {
        kind: "prices_daily",
        ref: bars.length
          ? `${company.ticker} ${bars[0].date}..${bars.at(-1)!.date}`
          : company.ticker,
      },
    ]);
  }
);

server.registerTool(
  "price_quote",
  {
    title: "Price quote",
    description: "Most recent stored daily bar for a ticker.",
    inputSchema: { ticker: z.string() },
  },
  async ({ ticker }) => {
    const company = await resolve(ticker);
    if (typeof company === "string") return failed(company);

    const [bar] = await getPriceHistory(company.id, { limit: 1 });
    if (!bar) return failed(`no prices stored for ${company.ticker}; run fetch-prices first`);

    return reply(bar, [
      companySource(company),
      { kind: "prices_daily", ref: `${company.ticker} ${bar.date}` },
    ]);
  }
);

server.registerTool(
  "filings_list",
  {
    title: "Filings list",
    description: "Filings on record for a company, most recently filed first.",
    inputSchema: {
      ticker: z.string(),
      formType: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
  },
  async ({ ticker, formType, limit }) => {
    const company = await resolve(ticker);
    if (typeof company === "string") return failed(company);

    const filings = await getFilings(company.id, { formType, limit });
    return reply(
      filings,
      filings.map((f) => ({
        kind: "filing" as const,
        ref: f.accession,
        id: f.id,
        url: f.url ?? undefined,
      }))
    );
  }
);

server.registerTool(
  "filing_section",
  {
    title: "Filing section",
    description:
      `Verbatim text of a named section of a filing. Sections: ${SECTION_NAMES.join(", ")}. ` +
      "Defaults to the latest 10-K. Long sections page through offset.",
    inputSchema: {
      ticker: z.string(),
      section: z.enum(SECTION_NAMES as [string, ...string[]]),
      accession: z.string().optional(),
      offset: z.number().int().min(0).optional(),
      maxChars: z.number().int().min(500).max(50000).optional(),
    },
  },
  async ({ ticker, section, accession, offset, maxChars }) => {
    const company = await resolve(ticker);
    if (typeof company === "string") return failed(company);
    if (!company.cik) return failed(`no CIK stored for ${company.ticker}; run ingest-edgar first`);

    // An explicit accession is looked up among every filing on record, not just
    // the most recent page of them.
    const filings = await getFilings(company.id, accession ? { limit: 10_000 } : { formType: "10-K", limit: 1 });
    const filing = accession ? filings.find((f) => f.accession === accession) : filings[0];
    if (!filing) return failed(`no matching filing for ${company.ticker}`);

    try {
      const section_ = await getFilingSection(
        company.cik,
        filing.accession,
        filing.formType,
        section,
        { offset, maxChars }
      );
      // Recording the document as a source here is what lets a claim drawn from
      // this text cite it afterwards.
      const { sourceId } = await registerFilingSource(filing.accession);
      return reply(
        {
          ticker: company.ticker,
          accession: filing.accession,
          formType: filing.formType,
          filedAt: filing.filedAt,
          sourceId,
          ...section_,
        },
        [{ kind: "filing", ref: filing.accession, id: sourceId, url: section_.url }]
      );
    } catch (err) {
      return failed((err as Error).message);
    }
  }
);

server.registerTool(
  "watchlist_list",
  {
    title: "Watchlist",
    description: "Companies on the watchlist with any note recorded against them.",
    inputSchema: {},
  },
  async () => reply(await getWatchlist(actor.userId), [{ kind: "watchlist", ref: "all" }])
);

server.registerTool(
  "macro_series",
  {
    title: "Macro series",
    description: "Stored observations for a macro series, oldest first.",
    inputSchema: {
      seriesId: z.string().max(40),
      start: ISO_DATE.optional(),
      end: ISO_DATE.optional(),
      limit: z.number().int().min(1).max(2000).optional(),
    },
  },
  async ({ seriesId, start, end, limit }) => {
    const rows = await getMacroSeries(seriesId, { start, end, limit });
    return reply(rows, [{ kind: "macro_series", ref: seriesId }]);
  }
);

server.registerTool(
  "research_note_get",
  {
    title: "Research note",
    description:
      "Stored research for a company: every claim with the source and verbatim snippet behind it, plus how many expected inputs were retrieved. A field with no claims has not been researched and should be reported that way.",
    inputSchema: { ticker: z.string() },
  },
  async ({ ticker }) => {
    const company = await resolve(ticker);
    if (typeof company === "string") return failed(company);

    const note = await getResearchNote(actor.userId, company.id, company.ticker, company.name);
    const cited = new Map<string, ToolSource>();
    for (const claims of Object.values(note.fields)) {
      for (const claim of claims) {
        cited.set(claim.sourceId, {
          kind: "filing",
          ref: claim.source.title ?? claim.source.url,
          id: claim.sourceId,
          url: claim.source.url,
        });
      }
    }
    return reply(note, [companySource(company), ...cited.values()]);
  }
);

server.registerTool(
  "research_claim_add",
  {
    title: "Add research claims",
    description:
      "Record claims about a company. Each claim needs a sourceId returned by another tool and a snippet copied word for word from that source. Claims whose snippet cannot be found in the source they cite are rejected and listed back with the reason.",
    inputSchema: {
      ticker: z.string(),
      field: z.enum(RESEARCH_FIELDS),
      claims: z
        .array(
          z.object({
            text: z.string().describe("the claim being made"),
            sourceId: z.string().describe("id of a source returned by another tool"),
            snippet: z.string().describe("verbatim quote from that source supporting the claim"),
          })
        )
        .min(1),
    },
  },
  async ({ ticker, field, claims }) => {
    const company = await resolve(ticker);
    if (typeof company === "string") return failed(company);

    try {
      const result = await addClaims(actor.userId, company.id, field as ResearchField, claims);
      return reply(result, [companySource(company)]);
    } catch (err) {
      return failed((err as Error).message);
    }
  }
);

server.registerTool(
  "company_events",
  {
    title: "Company events",
    description:
      "News events for a company, most recent first. Each event is one story with the number of articles that covered it, never one signal per article. The canonical source id can be cited when writing a claim, but only the headline was stored, so the snippet has to come from that headline.",
    inputSchema: { ticker: z.string(), limit: z.number().int().min(1).max(100).optional() },
  },
  async ({ ticker, limit }) => {
    const company = await resolve(ticker);
    if (typeof company === "string") return failed(company);

    const events = await getEvents(company.id, limit);
    return reply(
      events,
      events.map((e) => ({
        kind: "sources" as const,
        ref: `${e.title} (${e.sourceCount} articles)`,
        id: e.canonicalSourceId,
        url: e.url,
      }))
    );
  }
);

server.registerTool(
  "thesis_open",
  {
    title: "Open a thesis",
    description:
      "Record why a position is held, together with the conditions that would mean the reason no longer holds. Turn the conditions into rules over stored metrics; a script checks them later without any model involved, so a rule naming a metric that is not stored is refused rather than kept as a tripwire that can never fire. " +
      `Available metrics: ${RULE_METRICS.join(", ")}.`,
    inputSchema: {
      ticker: z.string(),
      rationale: z.string().optional().describe("why the position is held, in your own words"),
      rules: z
        .array(
          z.object({
            metric: z.string(),
            operator: z.enum(["<", ">", "<=", ">="]),
            value: z.number(),
          })
        )
        .min(1)
        .describe("conditions that would invalidate the thesis"),
    },
  },
  async ({ ticker, rationale, rules }) => {
    const company = await resolve(ticker);
    if (typeof company === "string") return failed(company);

    try {
      const parsed = parseRules(rules);
      const id = await openThesis(actor.userId, company.id, rationale ?? null, parsed);
      return reply({ id, ticker: company.ticker, rules: parsed }, [companySource(company)]);
    } catch (err) {
      return failed((err as Error).message);
    }
  }
);

server.registerTool(
  "thesis_list",
  {
    title: "List theses",
    description:
      "Open and closed theses with every rule evaluated against the latest stored figures: the actual value, whether it breaches, and whether it could be checked at all. A rule with no stored value is reported as unchecked, not as passing.",
    inputSchema: { status: z.enum(["open", "invalidated", "closed"]).optional() },
  },
  async ({ status }) => {
    const evaluations = await listTheses(actor.userId, status);
    return reply(evaluations, [
      { kind: "scores", ref: "theses evaluated against latest annual fundamentals" },
    ]);
  }
);

server.registerTool(
  "thesis_close",
  {
    title: "Close a thesis",
    description: "Mark a thesis closed once the position is exited. Does not evaluate any rule.",
    inputSchema: { id: z.uuid() },
  },
  async ({ id }) => {
    const found = await setThesisStatus(actor.userId, id, "closed");
    if (!found) return failed(`no thesis with id ${id}`);
    return reply({ id, status: "closed" }, []);
  }
);

server.registerTool(
  "watchlist_add",
  {
    title: "Add to watchlist",
    description:
      "Put a tracked company on the watchlist with an optional note. The company must already be stored, since watching a ticker with no filings, prices or score behind it would watch nothing.",
    inputSchema: { ticker: z.string(), note: z.string().optional() },
  },
  async ({ ticker, note }) => {
    const company = await resolve(ticker);
    if (typeof company === "string") return failed(company);

    await addToWatchlist(actor.userId, company.id, note?.slice(0, 500) ?? null);
    return reply({ ticker: company.ticker, note: note ?? null }, [companySource(company)]);
  }
);

server.registerTool(
  "watchlist_remove",
  {
    title: "Remove from watchlist",
    description: "Take a company off the watchlist. Nothing else about it is deleted.",
    inputSchema: { ticker: z.string() },
  },
  async ({ ticker }) => {
    const company = await resolve(ticker);
    if (typeof company === "string") return failed(company);

    const removed = await removeFromWatchlist(actor.userId, company.id);
    return reply({ ticker: company.ticker, removed }, [companySource(company)]);
  }
);

server.registerTool(
  "macro_series_list",
  {
    title: "Macro series available",
    description:
      "Which macro series are stored, how many observations each holds and how recent they are. Use this before macro_series so a series id is never guessed.",
    inputSchema: {},
  },
  async () => reply(await listMacroSeriesIds(), [{ kind: "macro_series", ref: "catalogue" }])
);

async function main() {
  actor = await resolveActor();
  await server.connect(new StdioServerTransport());
  log.info({ userId: actor.userId }, "mcp server ready");
}

main().catch((err) => {
  // stderr: stdout belongs to the MCP protocol
  log.fatal({ err: { message: (err as Error).message } }, "mcp server could not start");
  process.exit(1);
});
