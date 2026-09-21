import "../lib/env";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type Decimal from "decimal.js";
import { ACCOUNT_ID, BENCHMARK_TICKER } from "../lib/constants";
import { getPortfolio } from "../lib/holdings";
import { getPortfolioSeries } from "../lib/timeseries";
import { getScores } from "../lib/scoring";
import { SECTION_NAMES, getFilingSection } from "../lib/filing-text";
import {
  companySource,
  findCompany,
  getFilings,
  getFundamentals,
  getMacroSeries,
  getPriceHistory,
  getTransactions,
  getWatchlist,
  type CompanyRow,
  type ToolSource,
} from "../lib/company";

const server = new McpServer({ name: "capitalos", version: "1.0.0" });

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
    inputSchema: { accountId: z.string().optional() },
  },
  async ({ accountId }) => {
    const { holdings } = await getPortfolio(accountId ?? ACCOUNT_ID);
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
        { kind: "transactions", ref: accountId ?? ACCOUNT_ID },
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
    inputSchema: { accountId: z.string().optional(), includeSeries: z.boolean().optional() },
  },
  async ({ accountId, includeSeries }) => {
    const account = accountId ?? ACCOUNT_ID;
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
      accountId: z.string().optional(),
      ticker: z.string().optional(),
      limit: z.number().int().min(1).max(500).optional(),
    },
  },
  async ({ accountId, ticker, limit }) => {
    const account = accountId ?? ACCOUNT_ID;
    const rows = await getTransactions(account, { ticker, limit });
    return reply(rows, [{ kind: "transactions", ref: account }]);
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
      start: z.string().optional(),
      end: z.string().optional(),
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

    const filings = await getFilings(company.id, accession ? {} : { formType: "10-K", limit: 1 });
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
      return reply(
        {
          ticker: company.ticker,
          accession: filing.accession,
          formType: filing.formType,
          filedAt: filing.filedAt,
          ...section_,
        },
        [{ kind: "filing", ref: filing.accession, id: filing.id, url: section_.url }]
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
  async () => reply(await getWatchlist(), [{ kind: "watchlist", ref: "all" }])
);

server.registerTool(
  "macro_series",
  {
    title: "Macro series",
    description: "Stored observations for a macro series, oldest first.",
    inputSchema: {
      seriesId: z.string(),
      start: z.string().optional(),
      end: z.string().optional(),
      limit: z.number().int().min(1).max(2000).optional(),
    },
  },
  async ({ seriesId, start, end, limit }) => {
    const rows = await getMacroSeries(seriesId, { start, end, limit });
    return reply(rows, [{ kind: "macro_series", ref: seriesId }]);
  }
);

async function main() {
  await server.connect(new StdioServerTransport());
}

main();
