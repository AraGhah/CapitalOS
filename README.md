# Capital OS

A personal investment research desk. Code computes every number; the model only
explains what the code and the feeds found, and says where it got it.

Design and feature intent live in `../README.md`. The build order lives in
`../AI Investment Desk — Build Guide.md`. This file is just how to run it.

## Setup

```bash
npm install
docker compose up -d                  # Postgres on :5433, or point DATABASE_URL anywhere
psql -U capitalos -d capitalos -f schema.sql
npm run migrate-desk                  # the research-desk tables
npm run migrate                       # every idempotent layer: desk, consensus, lab, autopilot, hardening (splits, ledger checks)
npm run dev                           # serves http://127.0.0.1:3000 only
```

`.env.local`:

| Variable | Needed for | Without it |
| --- | --- | --- |
| `DATABASE_URL` | everything | the app cannot start |
| `SEC_USER_AGENT` | EDGAR and GDELT politeness | a default contact string is sent |
| `ANTHROPIC_API_KEY` | the strategist's brief, and the chat | verdicts still come out, from the sentiment counts; the brief renders as missing and the chat is unavailable |
| `ANTHROPIC_MODEL` | overriding the model | `claude-opus-5-5` |
| `DAILY_DOSSIER_BUDGET` | capping spend | 40 pipeline runs per day, then runs stop |
| `OPENAI_API_KEY` | hosted embeddings for event clustering | local hashed-token vectors |
| `ALPHA_VANTAGE_API_KEY` | `fetch-prices` | use `fetch-prices-yahoo` instead, which needs no key |
| `OPENAI_API_KEY` + `OPENAI_MODEL` | an OpenAI seat on the committee | the key alone is only used for embeddings |
| `GEMINI_API_KEY` + `GEMINI_MODEL` | a Gemini seat | — |
| `XAI_API_KEY` + `XAI_MODEL`, `DEEPSEEK_API_KEY` + `DEEPSEEK_MODEL`, `OPENROUTER_API_KEY` + `OPENROUTER_MODEL` | more seats | — |
| `DAILY_CONSENSUS_BUDGET` | capping committee spend | 12 committee runs per day, then runs stop |
| `PAPER_STARTING_CAPITAL` | paper trading | $100,000 |
| `AUTOPILOT_CRON` | how often `npm run autopilot` passes | every 30 minutes |
| `AUTOPILOT_CONVENE=1` | letting the autopilot convene committees | alerts only, no model calls |
| `AUTOPILOT_MAX_COMMITTEES`, `AUTOPILOT_MODE` | the autopilot's daily committee cap and mode | 3 a day, standard |
| `DAILY_CHAT_BUDGET` | capping copilot questions | 150 a day, then the chat refuses |
| `CAPITALOS_TOKEN` | requiring an access token | anyone who can reach the server is let in (it only listens on 127.0.0.1) |
| `CAPITALOS_ALLOWED_HOSTS` | serving under another host name, e.g. a LAN IP | only `localhost`, `127.0.0.1` and `[::1]` are served |
| `POSTGRES_PASSWORD` (shell, for `docker compose`) | a real database password | `capitalos`, with the port bound to 127.0.0.1 |

## Access

The desk holds a brokerage ledger and spends model credits, so `proxy.ts` sits in
front of every page and route:

- `npm run dev` / `npm start` listen on `127.0.0.1` only. To reach the desk from
  another device, run it with `-H 0.0.0.0`, add that device-facing host to
  `CAPITALOS_ALLOWED_HOSTS`, **and** set `CAPITALOS_TOKEN`.
- With `CAPITALOS_TOKEN` set, open `/?token=<value>` once per browser (it is kept
  in an httpOnly cookie) or send `Authorization: Bearer <value>` from scripts.
- Writes from another site are refused (Origin / Sec-Fetch-Site), and write bodies
  must be `application/json`, so a web page cannot place trades, write the ledger
  or convene a committee on your behalf.
- A question in an `/ask?q=` link is only pre-filled; it runs when you press Ask.
- Opening `/research/<ticker>` for a symbol the desk has not seen only offers to
  add it; nothing is written until you press the button.

Market capitalisation uses shares outstanding at the period end
(`shares_outstanding`) and falls back to diluted weighted shares. After updating,
run `npm run ingest-edgar` once to pick the new figure up.

With only `ANTHROPIC_API_KEY`, the committee seats Claude Opus, Sonnet and Haiku
(`models.json`). Different providers disagree for more useful reasons than three
sizes of one model, so each extra provider key makes the consensus worth more.

## Filling it with data

```bash
npm run fetch-prices-yahoo    # daily bars, no key needed (adds the SPY benchmark)
npm run ingest-edgar          # filings and XBRL facts
npm run compute-scores        # percentile scores from weights.json
npm run ingest-news           # GDELT event clusters
npm run ingest-fred           # macro series
npm run check-theses          # flag theses whose rules have been crossed
```

The five discovery feeds — GDELT, Google News, Yahoo Finance, Hacker News and
Reddit — are fetched by the pipeline itself, from the **Run the desk** button on
any research page. Nothing on that path needs a key.

## The investment committee

`/committee` convenes several models on one company. It is the Capital
Intelligence Consensus from the product plan, built as five phases:

1. **Evidence** — `lib/ai/evidence.ts` builds one pack from stored filings,
   computed ratios, prices (Yahoo when nothing is stored), valuation multiples,
   sector scores, headlines, sourced research notes, open theses, the position
   and FRED macro. Every item gets an id (`E12`). Every model reads the same pack.
2. **Blind analysis** — each analyst seat scores eight dimensions from −2 to +2
   and makes claims that must cite evidence ids. None sees another's answer. The
   committee mode adds six specialist seats (financial, valuation, industry,
   macro, news, risk), each scoring only its own dimensions.
3. **Debate** — a bull and a bear argue from the anonymised analyst views; a
   challenger attacks the preliminary consensus.
4. **Fact check** — `lib/ai/factcheck.ts` pulls every figure out of every claim
   and tests it against the items the claim cites, by arithmetic. A model then
   rules on the claims that carry no figure. Failed claims never reach the
   conclusion.
5. **Judge and synthesis** — the judge weighs the arguments, marks weak claims,
   grades each analyst and records the disagreements; the synthesizer writes the
   conclusion from what survived. Any figure in it the checker cannot find is
   sent back once for correction, and flagged if it survives.

Agreement per dimension and the confidence score are computed by
`lib/ai/consensus.ts` from the seats' scores, the checker's results and the
evidence coverage — no model is asked how confident to be. Every conclusion has
a **Why?** listing the reasons.

| Mode | Seats | Adds |
| --- | --- | --- |
| Fast | 1 | code fact check only |
| Standard | up to 3 | synthesizer |
| Deep research | up to 4 | model fact checker, challenger, judge |
| Investment committee | up to 4 | six specialists, bull/bear debate |

Every model call is metered in `model_calls` (tokens, cache reads, latency, and
price when `models.json` has one). Each run is cached on a hash of the evidence,
the mode, the question and the line-up. The grades feed `model_evaluations`,
and after three graded runs a model's record overrides the tier default when
the router picks who does which job (`/ai`).

A committee's invalidation conditions can be adopted as a monitored thesis, and
its assumptions are remembered in `ai_memory` with the annual period they were
made from:

```bash
npm run check-memory          # after ingest-edgar: settle assumptions against the newer period
npm run selftest-consensus    # the checker, the arithmetic and one scripted committee run — no model calls
```

The seats follow CrewAI's role / goal / backstory pattern and ChatDev's phased
chat chain, with ChatDev's communicative dehallucination as the synthesizer's
revision loop. The ledger is metered per call, the way Modal meters compute
rather than billing for idle capacity.

The Capital Copilot (`/ask`) can convene a committee itself with the
`convene_committee` tool.

## Portfolio risk (`/risk`)

`lib/risk` measures the open positions — or the watchlist, or a what-if basket
like `NVDA:30, AMD:20, MSFT:50` — from a year of daily closes: volatility, beta,
maximum drawdown, one-day VaR, Sharpe, each position's share of the risk,
correlation, sector weights and days to exit. Hidden exposure is found by
measuring each position against eight factor ETFs (SPY, QQQ, IWM, SOXX, USO, TLT,
UUP, GLD): positions a theme explains at least 40% of are reported together,
whatever sector they are filed under. The scenario simulator moves each position
by its measured sensitivity to one factor ("semiconductors fall 30%"), and says
how much of the move the factor actually explains. The Command Center shows the
findings under **Risks developing**.

## Discovery (`/markets`, `/scanner`)

The market overview reads indices, the eleven sectors, rates, credit,
commodities, the dollar and crypto, and classifies the regime with fixed rules —
trend, volatility, growth appetite, breadth, credit, liquidity, curve,
inflation — each shown with the numbers that decided it. A model brief is
written only on request and fact-checked against those numbers.

The opportunity scanner runs six standing screens, or any screen built from
rules, over every company with filings on the desk and turns the matches into a
research queue that states why each one is there.

## Strategy lab (`/strategies`, `/paper`)

The backtester replays a strategy — a screen, a ranking, a position limit, a
rebalance calendar — over up to ten years with commission and slippage. It never
peeks: annual figures count only from the day their 10-K was filed, restatements
from the day they were. Results come with yearly and bull/bear breakdowns and
the survivorship-bias warning, because the universe is today's companies.

Paper trading fills simulated orders at live prices in its own table, never the
ledger, and compares the portfolio with the same dollars in SPY on the same
days. A committee report can be paper-traded in one click; the result is
tracked as that conclusion's score.

## The autopilot (`/alerts`)

```bash
npm run autopilot                 # a pass every 30 minutes, alerts only
npm run autopilot -- --once       # one pass, for the OS task scheduler
npm run autopilot -- --convene    # also convene committees on high-severity alerts
```

Each pass watches held and watched companies for unusual moves (at least 5% and
3σ of their own history), volume spikes, news surges and new filings; re-checks
every thesis and remembered assumption; measures portfolio risk; and compares
the market regime with the last pass. Every alert states the number that
triggered it and, for held positions, the effect on the portfolio, and each
event alerts once. Convening a committee is the only step that spends money, so
it is off unless asked for and capped per day.

The Capital Copilot reaches all of it: `portfolio_risk`, `run_scenario`,
`market_regime`, `run_screen`, `run_backtest`, `paper_portfolio`, `get_alerts`
and `convene_committee`, on top of the original news and quote tools.

```bash
npm run selftest-risk         # risk arithmetic, then a live basket
npm run selftest-strategy     # point-in-time fundamentals, then the preset backtests
```

## What is deterministic and what is not

This split is the point of the whole project, so it is enforced by the schema
rather than by convention:

- `fundamentals`, `prices_daily`, `scores`, `theses` — computed from filings and
  prices. No model touches them. `fundamentals` is append-only: a restatement is
  a new row.
- `research_notes` — every row needs a `source_id` and a verbatim `snippet`, both
  `NOT NULL`, so the database itself rejects an ungrounded claim.
- `headlines`, `dossiers`, `chat_messages` — everything a model writes lives here
  and nowhere else. Each headline keeps its `sources` row, and every dossier
  records the exact headlines it read in `dossier_headlines`, so a verdict can be
  traced back to its evidence.

- `consensus_runs`, `model_calls`, `claim_checks`, `model_evaluations`,
  `ai_memory`, `decision_journal` — the committee's output, every call behind it,
  every claim and what the checker found, and the evidence pack each run read,
  frozen with the run.
- `paper_trades`, `alerts`, `autopilot_runs` — simulated trades, kept apart from
  `transactions`, and what the autopilot found. Alerts are written by code
  crossing a threshold; no model writes one.

A dossier is cached on a hash of the exact headline set and labels it was built
from, so an unchanged company is never re-analysed or re-billed.

## Not financial advice

Every verdict is a summary of public news. Verify anything here before acting on it.
