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
| `SEC_USER_AGENT` | EDGAR, GDELT and FRED calls; SEC's fair-access policy asks for a real contact, e.g. `CapitalOS you@example.com` | those calls refuse to run until it is set |
| `ANTHROPIC_API_KEY` | the strategist's brief, headline tagging and the Claude seats | verdicts still come out, from the sentiment counts; the brief renders as missing and the committee uses whichever other provider keys are set |
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
| `SIGNAL_FEEDS` | outside signals read into the committee's evidence: `polymarket`, `stocktwits` (comma-separated) | Polymarket only; `none` switches both off |
| `SIGNAL_TTL_MINUTES` | how long a StockTwits or Polymarket reading is reused before it is fetched again | 360 |
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
   computed ratios, prices (Yahoo when nothing is stored), technical indicators,
   valuation multiples, sector scores, headlines, outside signals (Polymarket
   odds, StockTwits label counts), sourced research notes, open theses, the
   position and FRED macro. Every item gets an id (`E12`). Every model reads the
   same pack.
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

## Technical analysis and outside signals

Ported from TauricResearch/TradingAgents' market analyst and data vendors, with
the one change this desk requires: a model never produces a figure.

`lib/technicals.ts` computes, from a year of daily bars, the 10-day EMA, the 50-
and 200-day SMA, RSI(14), MACD(12,26,9), Bollinger bands(20,2), ATR(14), VWMA(20)
and the last session's volume against the 20 before it, plus the readings code
draws from them: trend, RSI zone, MACD momentum and slope, band position, and a
golden or death cross (20 sessions) or MACD cross (10 sessions). The conventions
are the textbook ones (Wilder smoothing for RSI and ATR, population deviation for
the bands) and the thresholds are in `THRESHOLDS`; they are conventions, not
predictions. A session still trading is left out, so a reading does not move
with every refresh.

The same figures reach you three ways: as numbered items in every committee's
evidence pack (`lib/ai/technical-items.ts`, so the fact checker can test any
indicator value a model writes), in the **Technicals** panel on each research
page, and at `GET /api/technicals/<ticker>` and through the MCP server's
`technical_indicators` tool.

Two outside signals join the pack when `SIGNAL_FEEDS` allows them:

- **Polymarket** (on by default): the implied probability of open, well-traded
  markets that name the company, plus the Fed-cut and recession markets. Shown
  as the crowd's odds, never as a forecast made here. Public read-only API.
- **StockTwits** (opt-in, `SIGNAL_FEEDS=stocktwits,polymarket`): only the
  bullish or bearish label each author put on their own post is counted, over
  the 30 most recent. The posts are never read into the pack, so a stranger's
  text cannot reach a model. Its public stream answers only some clients, and its
  terms are yours to accept, so it is off until you turn it on.

Neither can be asked for a past date. Each reading is stored in
`signal_snapshots` and reused for `SIGNAL_TTL_MINUTES`, so two committee runs on
the same morning read the same evidence and share a cache entry; snapshots older
than `RETENTION_SIGNAL_DAYS` (180) are trimmed. A feed that is off, blocked or
empty shows up in the pack's coverage line as not retrieved.

## The decision (`/committee/<run>`)

TradingAgents ends its pipeline with a research manager, a trader and a
portfolio manager, each a model writing a judgement. Here the three roles are
rules over numbers the desk already measured, so a decision costs nothing to
compute, no model is called, and the same inputs give the same decision. It sits
at the top of every finished committee run.

- **Research Manager** (`lib/decision/rating.ts`) turns the committee's eight
  dimension scores into one of five ratings: a weighted mean (valuation 1.25,
  news flow and macro 0.5, the rest 1) mapped onto buy ≥ 1.0, overweight ≥ 0.4,
  hold, underweight ≤ −0.4, sell ≤ −1.0. Then it holds the rating back where a
  mean hides the problem: Low confidence allows only hold, Medium only one tier
  either side; a fragile balance sheet allows nothing above hold; an expensive
  or disputed valuation, or figures the checker never found, allow nothing above
  overweight. Fewer than 60% of the weight scored means hold. Every step that
  moved the rating is listed with its reason.
- **Trader** (`lib/decision/plan.ts`) draws a plan for a purchase: the last close
  as the entry, or the 20-day average when RSI is overbought or the price is above
  its upper Bollinger band; a stop two ATRs below the entry; and the prices at
  which a win is 1.5, 2 and 3 times the risk. These are planning levels, **not
  price targets**: the committee is forbidden to forecast a price and so is this
  layer.
- **Portfolio Manager** (`lib/decision/decide.ts`, `sizing.ts`) puts the rating
  through your own situation and sizes it. A buy or overweight becomes an action
  only if your pre-investment checklist is not "not ready" and no rule in an open
  thesis is breached; an incomplete checklist or material risks halve the size.
  The size is the lowest of six ceilings, each stated in words on the page: a
  risk budget (the stop costs at most 0.5% / 1% / 1.5% of your capital for low /
  medium / high risk tolerance), a position cap (5% / 8% / 10%), the loss you said
  you could absorb, the 40% sector bar, liquidity (sellable in five sessions at
  10% of average daily dollar volume) and the position size on your profile; then
  scaled for conviction, an overweight (half) and a downtrend (half). Capital is
  what you hold plus the money you set aside to invest on `/profile`.
- **Risk debate** (`lib/decision/risk-debate.ts`) is TradingAgents' aggressive,
  conservative and neutral risk analysts, as three seats that hold the same
  measured figures to different bars instead of three models arguing. The sizing
  above looks at the stock and your capital; the debate looks at what you
  already own, on a year of daily returns of your holdings with and without the
  new money: how much the 1-day 95% loss of your whole book grows (as a share of
  capital: 0.20% / 0.35% / 0.60% for the conservative / neutral / aggressive
  seat), the beta to the S&P 500 of your whole capital (1.15 / 1.30 / 1.50; money
  not yet invested counts as zero), how much of your capital sits in this stock
  plus the holdings that move with it (correlation 0.6 / 0.7 / 0.8 or more; 25% /
  35% / 50%), which catches two stocks in different sectors that behave as one
  bet, and the sessions it takes to sell at 10% of volume (1 / 3 / 5). The
  largest position inside a seat's bars is that seat's position: the full
  proposal (approves), part of it (reduces), or none of the addition when less
  than a quarter of it fits (rejects). A test the desk cannot measure is never a
  free pass: the conservative and neutral seats keep only half and three quarters
  of the addition for each one. The seat that matches your risk tolerance decides
  (low follows the conservative seat, medium the neutral, high the aggressive;
  unset is low): it can cut the size or turn the purchase into an avoid, and the
  other two are shown as the range. It runs only for a purchase, and every bar
  is a constant in that file.

The result is one of seven actions: buy, add, hold, trim, sell, watch (not held,
not a purchase) or avoid (not held, and something says stay out). The desk is
long-only: an underweight cuts a holding by half, a sell exits it, and neither
ever opens a short.

Nothing is stored until you press **Record this decision**; that keeps the exact
inputs (including the rounded daily returns the risk debate ran on), the digest
of them and the price they were drawn at in `decisions` (never trimmed, and it
survives the run being deleted), writes a line to the
journal and audits it. The same inputs record once. `GET
/api/consensus/<run>/decision` computes it, `POST` records it, `GET
/api/decisions?ticker=` lists what you recorded, and the MCP server's
`investment_decision` tool returns it for an agent you run yourself.

```bash
npm run migrate    # applies 0018_decisions.sql
```

## The pre-investment checklist (`/profile`, every research page)

No stock is suggested until every question an investor should ask has an
answer. `lib/checklist.ts` works through the full checklist — 23 questions
plus whether the figures can be independently verified — about the person
first, then the company:

| Group | Questions |
| --- | --- |
| You | financial readiness (high-interest debt), emergency savings (months covered), objective, horizon, risk capacity (against a planned single-stock loss of at least 50%), whether you can explain the business |
| The business | business quality, growth (CAGR, down years, acceleration, costs versus revenue), profitability, cash flow (conversion, profits up while cash falls), financial stability (net debt/EBITDA, interest coverage, a 30% revenue shock), management (dilution, capital returns), competitive advantage (sustained ROIC, margin stability), verifiability (current SEC annual report) |
| The price | valuation: multiples, sector percentiles, pessimistic/normal/optimistic cash-flow scenarios and the growth the price assumes |
| The economy | rates, curve, inflation and unemployment against the company's debt and valuation |
| Your portfolio | diversification after buying, currency, liquidity (days to exit) |
| Costs and safety | round-trip trading cost, account and tax (TFSA, RRSP, FHSA room and US withholding), broker registration |
| Your plan | exit strategy (an open thesis with rules), downside in money against what you said you could lose |

Each answer is pass, caution, fail, **missing** (the desk lacks the data) or
**input** (only you can answer), with the figures it rests on and what it could
not verify. A failed question about *you* makes the verdict "not ready",
whatever the company looks like. The questions about you live on the investor
profile (`/profile`, table `investor_profiles`); your reasons and exit rules live
on a thesis. Every threshold is in the `T` table at the top of the file.

The MCP server exposes the same check as `pre_investment_check`, and an agent
using it must call it before suggesting any stock. Interest coverage and dividend payout read
`interest_expense` and `dividends_paid`; run `npm run ingest-edgar` once to pick
them up.

## Investor lenses and earnings drift (every research page)

Two more panels on the research page, and the second also reaches the committee.
Neither calls a model, so neither costs anything to compute.

### Investor lenses (`lib/personas/`)

virattt/ai-hedge-fund has a model play each famous investor. Here each investor
is a table of checks, written from their published books and letters and run by
code on the company's own annual figures; nothing is copied from that repository.
Eight lenses, 41 checks: **Graham** (defensive value: steady profit, a dividend,
growth, modest debt, a moderate price), **Buffett** (return on equity, margins,
debt a few years of profit could repay, owner earnings, dilution, owner earnings
against the Treasury yield), **Munger** (return on invested capital, steady gross
margin, a predictable record, cash conversion, net debt, dilution, price against
free cash flow), **Lynch** (growth he can live with, PEG, debt, free cash flow, growth from
sales), **Fisher** (sales growth, margins and their direction, returns on capital,
growth paid for from within), **Burry** (free cash flow yield, EV to operating
profit, balance sheet, distance below the high, real earnings), **Wood** (revenue
growth and acceleration, gross margin, operating leverage) and **Damodaran** (the
growth the price assumes, from the checklist's reverse discounted cash flow, set
beside the growth delivered; return above the cost of capital; cash flow to value).

Each check shows its bar, the figure measured and pass, partly (half credit), fail
or **no data**. A lens **fits** when the company clears 70% or more of the weight
it could measure, **does not fit** at 30% or less, is **mixed** between, and says
**not enough data** when under 60% of its weight could be measured (a check that
needs a record, such as consistency or growth, has no data below three annual
periods). A bank is not tested on debt, margins or returns on capital. Every bar is a constant at the top of `lib/personas/lenses.ts`, and
each lens lists what the investor weighed that no figure answers (the moat, the
management, the story) as **not measured**. The figures come from the same
functions as the pre-investment checklist, so the two never disagree about a
number. A lens is a way of looking, not a recommendation, and the checklist stays
the gate. Ackman, Pabrai, Jhunjhunwala, Druckenmiller and Taleb are not here: their
tests would either repeat these or need data the desk does not hold.

The lenses do not feed the committee or the decision. Eight investors who all
read the same ratios are not eight independent opinions, and putting them in the
evidence would have the models echo them.

### Earnings drift (`lib/earnings/`)

Stocks have tended to keep moving in the direction of an earnings surprise for
weeks afterwards (post-earnings-announcement drift, Ball and Brown 1968, Bernard
and Thomas 1989). The effect is documented, and has weakened as it became known.
The panel measures whether the latest quarter set it up; it forecasts nothing.

- **Surprise.** Without analyst estimates, as a seasonal random walk with drift:
  diluted EPS against the same quarter a year earlier, less the mean of up to
  eight earlier such changes, divided by their sample deviation (SUE). It needs at
  least four earlier changes; a beat or miss is 1 deviation or more. A quarter and
  its year-ago comparative are both read from the one filing, so a split between
  them cannot pass for a surprise.
- **Announcement.** The day of the 8-K filed under Item 2.02 (kept in
  `earnings_releases`), because the market reacts to the press release and the
  10-Q can follow it by weeks. Where no release is stored the 10-Q's filing date
  is used and the panel says so.
- **Reaction.** The stock's return less the S&P 500's from the close before the
  announcement day to the close after it, so an after-hours release is caught.
  The market agrees when it moved at least 0.5% in the surprise's direction.
- **Drift since.** The abnormal return after the reaction closed, against the 60
  sessions in which drift has been documented.

Prices are read as the technical read reads them (the desk's own bars while fresh,
complete sessions only). The same figures reach the committee as about a dozen
short items in its evidence pack (`lib/ai/earnings-items.ts`, kind `earnings`, a
new coverage input, "earnings surprise"), so the fact checker can test a number a
model writes; the reading is stated in words with no figure and no forecast. They
also come at `GET /api/earnings/<ticker>`, the lenses at `GET
/api/personas/<ticker>`, and through the MCP server's `earnings_drift` and
`investor_lenses` tools.

```bash
npm run migrate        # applies 0019_earnings_releases.sql
npm run ingest-edgar   # now also reads diluted EPS and the Item 2.02 8-Ks
```

Limits: the fiscal fourth quarter is not readable (a 10-K carries only the year),
so after an annual report the panel shows the last quarter it can read and says a
newer report exists; a company with fewer than five quarters of EPS is not scored;
the 8-K list is the recent-filings list EDGAR already returns, so an old
announcement may be dated by its 10-Q; and R&D spending and current assets are not
stored, which is why Fisher's R&D point and Graham's current ratio are listed as
not measured.

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

Each piece has its own page: risk and scenarios on `/risk`, the market regime
on `/markets`, screens on `/scanner`, backtests on `/strategies`, paper trading
on `/paper` and alerts on `/alerts`. There is no chat; the MCP server exposes
the desk's data (positions, filings, prices, technicals, the pre-investment
check) to an agent you run yourself.

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
- `headlines`, `dossiers` (and the old `chat_messages`, no longer written) —
  everything a model writes lives here and nowhere else. Each headline keeps its `sources` row, and every dossier
  records the exact headlines it read in `dossier_headlines`, so a verdict can be
  traced back to its evidence.

- `consensus_runs`, `model_calls`, `claim_checks`, `model_evaluations`,
  `ai_memory`, `decision_journal` — the committee's output, every call behind it,
  every claim and what the checker found, and the evidence pack each run read,
  frozen with the run.
- `decisions` — what the desk advised on a day, computed by code from a
  committee's scores and your own checklist, profile and portfolio, with the
  inputs it used. No model writes one.
- `earnings_releases` — the days companies announced earnings (8-K Item 2.02),
  public data shared by everyone. The earnings surprise, the reaction and the
  investor lenses are computed from filings and prices at read time and stored
  nowhere.
- `paper_trades`, `alerts`, `autopilot_runs` — simulated trades, kept apart from
  `transactions`, and what the autopilot found. Alerts are written by code
  crossing a threshold; no model writes one.

A dossier is cached on a hash of the exact headline set and labels it was built
from, so an unchanged company is never re-analysed or re-billed.

## Not financial advice

Every verdict is a summary of public news. Verify anything here before acting on it.
