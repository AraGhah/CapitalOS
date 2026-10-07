# CapitalOS — Production-Readiness Audit

Date: 2026-10-06 · Branch: `ara` @ `07e8846` · Scope: every tracked file (158 files, ~22k lines excluding the lockfile and CSS).

How the audit was done: I read the data layer, every API route, the proxy, LLM/chat/agents, the research pipeline, market-data clients, the portfolio/ledger math, the AI committee (orchestrator, providers, store, fact checker), the risk engine, the backtester (valuation path), the autopilot, the MCP server, the migrations and scripts, and sampled the frontend. I also ran `tsc --noEmit` (clean), `eslint` (clean) and `npm audit` (7 high, details in §7), and checked brokerage-API availability against current public docs (sources in §4).

---

## 0. Executive summary

CapitalOS is a **well-built single-user local research tool**. It is not yet a production system. The engineering is better than typical student work in several places:

- SQL is parameterized everywhere. Only constant fragments are interpolated, so I found no SQL injection.
- The ledger uses `Decimal`.
- Budgets use advisory locks.
- The proxy defends against DNS rebinding and checks Origin to block CSRF.
- Feed URLs are filtered by scheme.
- The AI layer is unusually rigorous: an evidence pack, a code-based figure checker, and a metered call ledger.

The gaps that stop it being production-grade or a serious FinTech showcase are structural, not cosmetic:

1. **No identity or tenancy model.** There is one hard-coded `ACCOUNT_ID`, one shared static token, and most tables have no owner column.
2. **The ledger can be corrupted.** A backdated sell can drive a position negative, and sell checks are racy.
3. **The backtester computes valuation metrics incorrectly** for any company that has split, because it multiplies pre-split share counts by split-adjusted prices.
4. **Market data comes from unofficial Yahoo endpoints and scraped RSS feeds.** That is a terms-of-service, reliability and credibility problem for a finance product.
5. **Long AI jobs run inside HTTP requests**, using in-process rate limiters and caches. There is no job queue, so a restart loses work, and the design cannot scale horizontally.
6. **There is no automated test suite, no CI, no versioned migrations, no structured logging or error tracking, and no deployable artifact.**
7. **Financial correctness gaps:** no cash, dividends or currency (CAD/USD); return is a simple ratio rather than TWR/MWR; `adj_close` is just `close`.

Counts: 1 Critical, 9 High, 21 Medium, 18 Low.

---

## 1. Architecture map (as built)

```
Browser (Next.js 16 App Router, React 19 server components + client islands)
   │  pages query the DB directly through lib/* (no service boundary)
   ▼
proxy.ts ── host allow-list · optional static token (cookie/bearer) · Origin/Sec-Fetch-Site · JSON-only writes
   │
   ├─ app/api/* (14 route handlers; 3 stream NDJSON for 5–13 min model runs)
   │
   ▼
lib/  (domain + infrastructure mixed in one layer)
   ├─ db.ts            pg Pool (defaults), advisory-lock helpers
   ├─ holdings/portfolio/splits   ledger math (Decimal, average cost)
   ├─ quote/market/bars/splits    Yahoo chart API (unofficial), in-memory 30-min cache
   ├─ feeds/news       GDELT, Google News RSS, Yahoo RSS, HN Algolia, Reddit RSS
   ├─ sec/edgar        SEC EDGAR (official) with on-disk cache in ./.cache
   ├─ llm/chat/agents  Anthropic Messages API (raw fetch), tool loop, in-process 4s rate gate
   ├─ ai/*             multi-provider committee, evidence pack, code fact-checker, ledger
   ├─ risk/* strategy/* scanner/scoring   pure-ish analytics
   └─ autopilot/*      trigger detectors → alerts → optional committee
scripts/*  (tsx CLIs: ingestion, migrations, autopilot cron via node-cron, self-tests)
mcp/server.ts (stdio MCP server exposing ledger/research tools to Claude Desktop)
Postgres 16 (docker-compose, loopback only) — 6 hand-applied SQL files, no migration table
```

**Coupling problems**
- Server components, API routes, the MCP server and CLI scripts all call `lib/*`, and `lib/*` calls `pool` and `fetch` directly. There are no repositories, no service interfaces and no dependency injection. Testing anything requires a live database and live network.
- Cross-cutting state lives in process memory: the LLM rate gate (`lib/llm.ts:32`), the provider gates (`lib/ai/providers.ts:41`), the GDELT and SEC throttles, the bars cache, and the ticker map. Three processes (web, autopilot, MCP) each hold their own copy, so the limits are not actually global.
- Request lifecycle and job lifecycle are the same thing: committee runs, autopilot passes and backtests execute inside the HTTP request (`maxDuration = 800`).

**Target architecture (recommended)**

```
apps/web (Next.js UI only, calls API via typed client)
apps/api (route handlers or Fastify/Hono) ── authN (OIDC session) ── authZ (owner_id on every row, RLS)
packages/domain   (ledger, risk, backtest, fact-check: pure, unit-tested, no I/O)
packages/adapters (MarketDataProvider, NewsProvider, BrokerageProvider, LLMProvider interfaces + impls)
packages/db       (migrations via drizzle-kit/node-pg-migrate, repositories, transactions)
workers/          (job queue: pg-boss or BullMQ — committee runs, autopilot, ingestion, broker sync)
infra/            (Dockerfile, compose for dev, IaC for prod, CI)
observability     (pino JSON logs + request ids, OpenTelemetry traces, Sentry, /healthz /readyz)
```

---

## 2. Prioritized issue register

Severity: Critical / High / Medium / Low. Priority: P0 = must fix immediately, P1 = must fix before production, P2 = important, P3 = refinement.

### P0 — fix immediately

#### LED-01 — Backdated sells can drive a position negative; sell validation is racy
- **Category:** Bug / Database · **Severity:** High · **Priority:** P0
- **Location:** `app/api/transactions/route.ts:72-87`, `lib/holdings.ts:62-75` (`heldQuantity`), `lib/portfolio.ts:41-50`
- **Problem:** A sell is validated only against the quantity held *on its own date*. Later sells are ignored. Example: buy 10 on Oct 1, sell 10 on Oct 5, then post a sell of 10 dated Oct 3. Ten shares were held on Oct 3, so the check passes, and the ledger now nets −10. The check and the `INSERT` are also two separate statements with no lock or transaction, so two concurrent sells can both pass. `buildPosition` then silently clamps oversells (`Decimal.min(txQty, qty)`), which hides the corruption instead of surfacing it.
- **Impact:** The stored ledger disagrees with every derived view. Realized P/L, cost basis and risk weights become wrong, and nothing flags it. For financial data this is the most serious class of bug.
- **Evidence:** `heldQuantity` breaks out of its loop at `when > at` (`lib/holdings.ts:70`) and returns `Decimal.max(held, 0)`. The route inserts without a transaction (`route.ts:82`).
- **Recommended fix:**
  - Validate that the running position stays ≥ 0 at **every** point after the new transaction is inserted (replay all rows, including the new one, in date order).
  - Do the check and the insert inside `BEGIN … SELECT … FOR UPDATE` (lock on a per-account row) or under an advisory lock keyed by account+company.
  - Make `buildPosition` throw or flag on oversell instead of clamping.
  - Add an `idempotency_key` column with a unique constraint so double-submits are no-ops.
  - Add void/correct operations (soft-delete with an audit row) instead of having none.

#### BT-01 — Backtest and scoring valuation metrics mix pre-split share counts with split-adjusted prices
- **Category:** Bug (financial correctness) · **Severity:** High · **Priority:** P0
- **Location:** `lib/strategy/backtest.ts:206-221` (`metricsAsOf`); the same pattern appears in `lib/scoring.ts:76`, `lib/scanner.ts:227` and `lib/ai/evidence.ts:548`
- **Problem:** `marketCap = shares(as filed) × bars[upto].close`. Yahoo closes are back-adjusted for *every later* split, but XBRL share counts are as reported at the time. Take a 10-for-1 split in 2024: every rebalance before it sees a market cap ~10× too small, so P/E, P/S and FCF-yield are off by 10×. That is also a look-ahead leak, because it uses knowledge of future splits. After any recent split, the scorer and the evidence pack understate market cap until the next 10-K arrives.
- **Impact:** Value screens and rankings select the wrong companies, and reported backtest returns are wrong in a direction you cannot predict. The committee's valuation evidence can be off by the split ratio.
- **Evidence:** `capitalisationShares(current.values)` is multiplied by `bars[upto].close`, and no `splitFactor` is applied. The `splits` table exists (`lib/splits.ts`) but is unused in these paths.
- **Recommended fix:** Restate shares onto the same basis as the price: `shares × splitFactor(splits, periodEnd, priceDate)`. Alternatively, un-adjust the price back to the as-of date. Add a regression test using a known split (e.g. a synthetic 4:1).

#### OPS-01 — No `pool.on('error')` handler, no pool/statement timeouts
- **Category:** Bug / DevOps · **Severity:** High · **Priority:** P0
- **Location:** `lib/db.ts:9-11`
- **Problem:** node-postgres emits `error` on idle clients when the database restarts or the network drops. With no listener, that is an unhandled `'error'` event, which crashes the Node process: the web server, the autopilot and the MCP server alike. There is also no `connectionTimeoutMillis` (waits forever), no `statement_timeout`, no `idleTimeoutMillis` and no `max`.
- **Impact:** A database restart kills every process. A slow query or lock wait can hang requests indefinitely.
- **Recommended fix:** `pool.on('error', log)`. Set `max`, `connectionTimeoutMillis: 5000`, `idleTimeoutMillis`, and `options: '-c statement_timeout=15000'` (longer for the workers). Add a `/readyz` endpoint that pings the DB.

#### SEC-01 — No identity, authorization or tenant isolation
- **Category:** Security / Architecture · **Severity:** Critical (for any deployment) · **Priority:** P0 on the production track
- **Location:** `lib/constants.ts:2` (`ACCOUNT_ID`), `proxy.ts:66-87`, all schemas
- **Problem:** "Auth" is an optional single shared secret. There are no users and no sessions. The cookie *is* the raw token: no expiry server-side, no rotation, no revocation, no per-user audit. The data model has an `account_id` only on `transactions`, and that column has no foreign key. `watchlist`, `theses`, `paper_trades`, `alerts`, `chat_messages`, `decision_journal`, `consensus_runs` and `ai_memory` have no owner. The MCP tools accept a caller-supplied `accountId` (`mcp/server.ts:63,95,135`): an IDOR waiting to happen once a second account exists. `CAPITALOS_TOKEN` has no minimum length and failed attempts are not rate-limited.
- **Impact:** Today this is mitigated by binding to loopback. The moment the app is deployed, it is either wide open (no token) or protected by one guessable shared password, with no way to separate users' financial data.
- **Recommended fix:**
  - Introduce `users` and `accounts` tables, with `owner_id` on every user-scoped table and a foreign key on `transactions.account_id`.
  - Use OIDC (Auth.js, Clerk or Supabase Auth) with server-side sessions, httpOnly + Secure + SameSite=Lax cookies, short TTL and rotation.
  - Derive `accountId` from the session, never from input.
  - Enforce ownership in a repository layer and back it with Postgres RLS (`SET app.user_id` per transaction).
  - Rate-limit auth endpoints and add an `audit_log` table for every write to the ledger.

### P1 — must fix before production

#### ARC-01 — Long-running AI work executes inside HTTP requests; no job queue
- **Category:** Architecture / Performance · **Severity:** High · **Priority:** P1
- **Location:** `app/api/consensus/route.ts:9,35-73`, `app/api/research/[ticker]/route.ts:14`, `app/api/autopilot/route.ts:6`, `app/api/chat/route.ts:15`
- **Problem:** Committee runs (up to ~16 model calls), research pipelines and autopilot passes run inside the request, with `maxDuration` up to 800 s. If the client disconnects the run continues, but a server restart or deploy kills it. `reapStaleRuns` cleans up only after 30 minutes. There is no retry, priority, concurrency limit or visibility. On most serverless hosts the duration cap is lower than 800 s.
- **Impact:** Lost paid work, stuck "running" rows, no horizontal scaling, and requests tied up for minutes.
- **Recommended fix:** Use a Postgres-backed queue (pg-boss fits the existing stack; BullMQ if you add Redis). `POST /api/consensus` enqueues a job and returns `202 {runId}`. A worker executes it and publishes progress through a `run_events` table plus SSE/LISTEN-NOTIFY. Make jobs idempotent on `cache_key`. Run the autopilot as a scheduled job on the same queue instead of `node-cron` in a separate process.

#### ARC-02 — Rate limits, throttles and caches live in process memory
- **Category:** Architecture / Integration · **Severity:** Medium · **Priority:** P1
- **Location:** `lib/llm.ts:32-40` (4 s global gap), `lib/ai/providers.ts:41-50`, `lib/news.ts:30-35`, `lib/sec.ts:19-26`, `lib/market/bars.ts:25`, `lib/resolve.ts:19`
- **Problem:** Each process (web, autopilot, MCP, any script) has its own clock. Running two of them doubles the request rate against SEC (whose fair-access policy is 10 req/s), GDELT and Anthropic. The 4 s Anthropic gap also serializes *all* model calls in a process: a committee's parallel `Promise.all` becomes about 64 s of pure waiting.
- **Recommended fix:** Use a shared token bucket (Postgres row or Redis) keyed per provider. Let Anthropic's own `429`/`retry-after` drive backoff (already in `lib/http.ts`) and replace the fixed gap with a concurrency limit (e.g. p-limit 4). Move caches to Redis or Postgres with TTLs.

#### DATA-01 — Primary market data and news come from unofficial or scraped endpoints
- **Category:** Integration / Legal / Reliability · **Severity:** High · **Priority:** P1
- **Location:** `lib/quote.ts:52-61` and `lib/splits.ts:28-35` (`query1.finance.yahoo.com/v8/finance/chart`), `lib/feeds.ts:115-149` (Google News RSS, Yahoo RSS, Reddit `search.rss`)
- **Problem:** Yahoo's chart endpoint is undocumented and not licensed for redistribution or commercial use. It changes without notice, rate-limits aggressively, and has broken many libraries before. Paper-trade fills, risk, the market regime, the backtester (10 years for every ticker, `lib/strategy/backtest.ts:255`) and the price ingestion all depend on it. Reddit's terms require API registration for programmatic access, and its RSS is not a sanctioned data feed for products. For a project positioned as FinTech, a reviewer will read this as "scrapes Yahoo".
- **Impact:** Silent outages, wrong fills, possible terms-of-service violations, and lost credibility.
- **Recommended fix:**
  - Introduce a `MarketDataProvider` interface and keep Yahoo only as a dev-only adapter, off by default.
  - Use a licensed provider for prod: Polygon/Massive, Tiingo, Twelve Data, Alpaca Market Data (free IEX feed) or Financial Modeling Prep. Store provider and licence on every price row.
  - Use the Reddit official API with OAuth or drop it.
  - Keep SEC EDGAR, GDELT and HN Algolia, which are official or public APIs.

#### TEST-01 — No automated tests, no CI
- **Category:** Testing / DevOps · **Severity:** High · **Priority:** P1
- **Location:** repo root (no `test/`, no test runner, no `.github/workflows`)
- **Problem:** The three `selftest-*` scripts are useful but need a live database, network access and (for risk/strategy) live Yahoo. Nothing runs on push. The highest-risk code is ledger math, splits, the backtester's point-in-time logic, the fact checker, budgets and the proxy, and none of it is regression-protected.
- **Recommended fix:** See §6. Vitest for units, Testcontainers Postgres for integration, MSW for HTTP fakes, Playwright for e2e, and a GitHub Actions pipeline (lint, typecheck, unit, integration, build, `npm audit --omit=dev`, CodeQL, gitleaks).

#### DB-01 — No migration system; base schema is not idempotent; constraints left NOT VALID
- **Category:** Database / DevOps · **Severity:** High · **Priority:** P1
- **Location:** `schema*.sql`, `scripts/migrate*.ts`, `README.md` setup
- **Problem:** `schema.sql` is applied by hand with plain `CREATE TABLE`. The layers are re-run in full every time, with no `schema_migrations` table, ordering guarantee, checksum or down path. There are four redundant migrate scripts. `schema-hardening.sql` adds ledger CHECKs `NOT VALID` and never validates them. There is no way to know what version a database is at.
- **Recommended fix:** Adopt node-pg-migrate, drizzle-kit or Atlas. Convert the six files into numbered migrations, add a migration that validates the constraints after a cleanup query, and run migrations in CI against a fresh database.

#### OPS-02 — No logging, tracing, metrics, error tracking or health checks
- **Category:** DevOps / Observability · **Severity:** High · **Priority:** P1
- **Location:** whole codebase (only `console.*` in scripts; route handlers log nothing)
- **Problem:** Errors are returned to the client and otherwise lost. There are no request IDs and no record of who did what to the ledger. Model calls are metered in the database (good), but there is no latency/error dashboard and no alerting.
- **Recommended fix:** pino JSON logger with a request-id middleware; OpenTelemetry instrumentation for http, pg and fetch; Sentry for both server and client; `/healthz` and `/readyz`; and a Grafana or Datadog dashboard for p95 latency, provider error rates, daily spend, queue depth and ingestion freshness. Do **not** log tokens, prompts containing portfolio data, or full model outputs at info level.

#### SEC-02 — Missing security headers (CSP, frame-ancestors, HSTS…)
- **Category:** Security · **Severity:** Medium · **Priority:** P1
- **Location:** `next.config.ts` (no `headers()`), `app/layout.tsx:48` (inline script)
- **Problem:** Without a CSP or `frame-ancestors`, any site can frame the desk (clickjacking: buttons that convene paid committees or place paper orders). The inline theme script would need a nonce or hash under a CSP.
- **Recommended fix:** Set `Content-Security-Policy` (`default-src 'self'; frame-ancestors 'none'; script-src 'self' 'nonce-…'`), `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`, and HSTS when served over HTTPS.

#### SEC-03 — Token bootstrap via query string; cookie holds the raw secret
- **Category:** Security · **Severity:** Medium · **Priority:** P1 (superseded by SEC-01)
- **Location:** `proxy.ts:66-80`
- **Problem:** `/?token=<secret>` lands in browser history and any proxy or access logs before the redirect. The cookie *is* the secret, so a leaked cookie is a permanent credential. `secure` is only set when the request was HTTPS, so behind a TLS-terminating proxy it is never set.
- **Recommended fix:** Until SEC-01 lands: a POST login form; the cookie holds an HMAC-signed session ID with expiry, not the token; `secure` derived from `x-forwarded-proto` or always on in production; constant-time compare kept; minimum token length (≥32 random bytes) enforced at startup.

#### AI-01 — Prompt injection can trigger side-effecting tools; enforcement is prompt-only
- **Category:** Security (LLM) · **Severity:** Medium · **Priority:** P1
- **Location:** `lib/chat.ts:38-57` (system rules), `lib/chat.ts:525-557` (`runTool`), `lib/agents.ts:114-139`
- **Problem:** Third-party headline text flows into the analyst, strategist, committee and chat contexts. The rule "only research tickers the person named" is an instruction to the model, not a code check. A hostile headline that says "research XYZ" can make the copilot run `research_ticker`, which writes to the watchlist and creates company rows, or run `convene_committee` (paid). `allowedMode` limits the *mode* but not *whether* to convene. Tool results are unbounded `JSON.stringify` output, so a large risk report becomes a cost amplifier.
- **Recommended fix:**
  - In code, require that the ticker for a side-effecting tool (`research_ticker`, `convene_committee`) appears in the user's own message (or a confirmed UI selection); otherwise return a tool error.
  - Cap each tool result (e.g. 8 KB) and truncate.
  - Wrap third-party text in delimited data blocks.
  - Log any tool call that was refused.

#### AI-02 — A committee that succeeded can be recorded as failed
- **Category:** Bug · **Severity:** Medium · **Priority:** P1
- **Location:** `lib/ai/committee.ts:415-443`
- **Problem:** `finishRun()` marks the run `done`, then `remember()` and `addJournal()` run in the same `try`. If either throws (a constraint violation or a transient DB error), the `catch` calls `failRun()`, which overwrites the status to `failed` on a paid, completed run. Separately, `RunContext.ask` increments `calls` in both `meter()` and the `catch` path, so a failure after metering double-counts (`committee.ts:170,210`).
- **Recommended fix:** Move post-processing out of the try, or make it best-effort with its own catch and logging. Make `failRun` `WHERE status = 'running'`. Wrap `finishRun`, `saveClaims` and `saveEvaluations` in one DB transaction.

#### CFG-01 — Configuration fails open; no env validation
- **Category:** Bug / Security · **Severity:** Medium · **Priority:** P1
- **Location:** `lib/llm.ts:164`, `lib/chat.ts:647`, `lib/ai/committee.ts:88`, `lib/autopilot/cycle.ts:31`, `lib/paper.ts:19`
- **Problem:** `Number(process.env.X ?? 12)`. A typo such as `DAILY_CONSENSUS_BUDGET=12/day` gives `NaN`. Then `runsToday() >= NaN` is false, and `Math.max(0, NaN - n)` is `NaN`, which is not `<= 0`. **Every spend cap silently becomes unlimited.** `DATABASE_URL` missing produces only an obscure pg error at first query.
- **Recommended fix:** One `lib/config.ts` that parses `process.env` with zod (already a dependency) at boot, with sane defaults, integer/positive constraints, and a hard failure on invalid values. Add a `.env.example`.

#### COST-01 — Budgets count runs, not dollars; every model is unpriced
- **Category:** Architecture / Cost · **Severity:** Medium · **Priority:** P1
- **Location:** `models.json` (all `priceIn`/`priceOut` are `null`), `lib/ai/providers.ts:69`
- **Problem:** Cost cannot be shown or capped in dollars. A "deep" run and a "fast" run count the same, and cache-read pricing is ignored (by design, but it overstates cost). The chat budget check is check-then-act (`app/api/chat/route.ts:40-48`).
- **Recommended fix:** Fill in prices with dates. Add `DAILY_SPEND_USD_LIMIT`, enforced by summing `model_calls.cost_usd` plus in-flight reservations under the existing lock. Price cache reads and writes at their real rates.

#### FIN-01 — Portfolio model omits cash, dividends, currency and proper return math
- **Category:** Financial correctness · **Severity:** High (for a FinTech platform) · **Priority:** P1
- **Location:** `lib/portfolio.ts:102-118` (`totalReturn`), `scripts/fetch-prices-yahoo.ts:74` (`adj_close = close`), `lib/quote.ts` (currency read but ignored), `schema.sql` (`transactions`)
- **Problem:**
  - "Total return" is `(realized + unrealized) / cost ever invested`. That is neither time-weighted nor money-weighted, so it is misleading whenever money is added over time.
  - There is no cash ledger, deposits/withdrawals, dividends, interest, fees-as-events, FX or currency column. A Canadian user holding CAD and USD positions gets them summed as if same-currency.
  - `adj_close` is stored as the unadjusted close, so the column name lies.
  - Average cost matches Canadian ACB, which is fine, but there are no lots, so US tax reporting is impossible.
- **Recommended fix:** Use an event-sourced ledger with `cash_movements`, `dividends`, `corporate_actions`, and `currency` + `fx_rate` on every money row. Compute TWR (daily-linked) and MWR (XIRR). Store true dividend-adjusted closes or a total-return series from a licensed provider, and label which one each metric uses.

#### SEC-04 — Dependency vulnerabilities
- **Category:** Security / Dependencies · **Severity:** Medium · **Priority:** P1
- **Location:** `package.json`
- **Problem:** `npm audit` reports 7 high:
  - `@modelcontextprotocol/sdk` 1.30.0 (GHSA-6qxp-vccf-f47h). The vulnerable code is the OAuth *client*; this repo uses only the stdio *server*, so it is not exploitable here.
  - `sharp` < 0.35.5 (CVE-2026-96889, a librsvg issue; reachable only if untrusted SVGs go through next/image, which none do).
  - The `eslint-config-next` → `fast-glob` → `micromatch` → `braces` chain, which is dev-only.
- **Recommended fix:** `npm audit fix` (MCP SDK → ≥1.31, sharp → ≥0.35.5). Track Next 16.4. Add Dependabot or Renovate plus `npm audit --omit=dev --audit-level=high` in CI.

#### DEP-01 — Deployment story: localhost-only, no app container, filesystem state
- **Category:** DevOps · **Severity:** Medium · **Priority:** P1
- **Location:** `package.json` scripts (`-H 127.0.0.1`), `proxy.ts:59` (host allow-list returns 421), `lib/sec.ts:6` (`./.cache`), `lib/ai/models.ts:247` (`models.json` via `process.cwd()`), `docker-compose.yml` (DB only)
- **Problem:** There is no Dockerfile for the app and no production config. The EDGAR cache is written to the working directory, which is read-only or ephemeral on serverless and containers, and writes are not atomic, so concurrent writers can tear a file. `models.json` and `weights.json` are read with sync I/O on every call.
- **Recommended fix:**
  - Multi-stage Dockerfile using `output: "standalone"` and a non-root user.
  - Compose file with `web`, `worker` and `db` services.
  - Move the EDGAR cache to object storage or a `http_cache` table.
  - Load `models.json` once at boot with validation.
  - Document a deployment target (Fly.io or Render, or AWS ECS + RDS) and add IaC (Terraform) for it.

#### PERF-01 — N+1 writes and unbounded fan-out
- **Category:** Performance · **Severity:** Medium · **Priority:** P1
- **Location:** `lib/dossier.ts:30-63` (2–3 sequential queries per article, ~250 articles a run), `lib/news.ts:243-288`, `scripts/fetch-prices-yahoo.ts:74` (row-by-row), `lib/strategy/backtest.ts:255` (`Promise.all` of 10-year Yahoo charts for every ticker), `lib/splits.ts:49-57`
- **Recommended fix:** Batch inserts with `unnest()` (already used in `saveTags`). Add a unique index on `sources(url)` and use `INSERT … ON CONFLICT … RETURNING`. Bound fan-out with p-limit (4–6). Read backtest bars from `prices_daily`, not the network.

#### DB-02 — Missing constraints and indexes; unbounded growth
- **Category:** Database · **Severity:** Medium · **Priority:** P1
- **Problems and fixes:**
  - `sources.url` has no unique constraint, so concurrent scouts race (`lib/dossier.ts:33` comments on it). Fix: `UNIQUE(url)`, after deduplicating.
  - `fundamentals` dedup happens in app memory (`scripts/ingest-edgar.ts`) with no natural-key constraint, so concurrent ingests duplicate rows. Fix: `UNIQUE(company_id, metric, period_end, fiscal_period, filing_id, value)`.
  - `transactions.account_id` has no foreign key and no index. Fix: `INDEX(account_id, company_id, executed_at)`.
  - No indexes on `theses(company_id, status)`, `research_notes(company_id)`, `filings(company_id, filed_at DESC)`, `headlines(company_id) WHERE sentiment IS NULL`, `budget_reservations(kind, created_at)`, or `companies(upper(ticker))`. `findCompany` uses `upper(ticker) = upper($1)` and so cannot use the unique index.
  - `prices_daily (company_id, date)` index duplicates the primary key. Fix: drop it.
  - Only one code path uses a DB transaction (`lib/scoring.ts:121`). `saveDossier` (two inserts), `finishRun` + claims + evaluations, and alert + journal writes can half-commit.
  - `chat_messages`, `model_calls.raw_text`, `headlines` and `consensus_runs.evidence` (a full JSON pack per run) grow forever. Fix: retention jobs and partitioning by month for `model_calls` and `alerts`.

#### DB-03 — `withLock` can deadlock the pool; locks can leak
- **Category:** Bug / Database · **Severity:** Medium · **Priority:** P1
- **Location:** `lib/db.ts:24-52`
- **Problem:** `withLock` holds a pooled client blocked on `pg_advisory_lock` while `fn` uses *other* pool clients. If ≥ `max` (default 10) callers wait at once, the lock holder cannot get a client and every caller waits forever (no `connectionTimeoutMillis`). If `pg_advisory_unlock` fails, `client.release()` returns a connection that still holds a session-level lock to the pool.
- **Recommended fix:** Pass the locked `client` into `fn` and run the critical section on it, or use `pg_advisory_xact_lock` inside a `BEGIN … COMMIT` on that client. On error, `client.release(err)` to destroy it. Add `lock_timeout`.

### P2 — important improvements

| ID | Issue | Cat. | Sev. | Location | Problem → Fix |
|---|---|---|---|---|---|
| AI-03 | Fact checker matches numbers, not meaning | AI/Bug | Medium | `lib/ai/factcheck.ts:153-171, 106` | A figure "verifies" if *any* cited item holds that value in a compatible unit. "Margin is 12%" citing a 12% *growth* item passes. Bare numbers ≤ 12 are never checked ("P/E of 9"). → Require a label/metric keyword match between the claim and the item; check small bare numbers next to valuation words; add a golden-set eval. |
| AI-04 | Router learns from model-written grades | AI | Low | `lib/ai/models.ts:353-406` | Judge-model grades feed routing, which creates a self-reinforcing loop. → Weight code-verified accuracy far above judge grades; require cross-provider judging. |
| AI-05 | `extractJson` and `max_tokens` truncation | Bug | Low | `lib/llm.ts:131-145` | `stop_reason === "max_tokens"` is not detected, so truncated JSON reaches the brace-slicing fallback. → Check `stop_reason`; use tool-use / structured output (JSON schema) for every structured call. |
| SEC-05 | Internal error messages returned to clients | Security | Low | most routes (`err.message`) | pg and provider errors leak schema and model details. → Map errors to codes; log details server-side with a request ID. |
| SEC-06 | MCP inputs not validated | Security | Medium | `mcp/server.ts:63,129,348,503` | `accountId`, `id`, `start`/`end` are free strings that reach SQL as uuid/date and throw raw pg errors; `accountId` is caller-chosen. → zod `.uuid()`/`.date()`; derive the account from config, not input. |
| SEC-07 | SEC contact default | Integration | Low | `lib/sec.ts:5`, `lib/news.ts:49` | The `contact@example.com` User-Agent breaks SEC fair-access policy and risks an IP block. → Require `SEC_USER_AGENT` at boot. |
| RACE-01 | Research pipeline has no per-ticker lock | Bug | Medium | `app/api/research/[ticker]/route.ts`, `lib/chat.ts:242` | Two clicks double-tag and double-bill. → Advisory lock keyed by `hashtext(ticker)` or a job deduplicated on (ticker, hash). |
| LED-02 | No edit/void, idempotency or audit trail for ledger rows | Database | Medium | `app/api/transactions/route.ts` | Mistyped trades cannot be corrected; double submit inserts twice. → See LED-01. |
| PAPER-01 | Paper fills ignore market hours and spread; float math | Bug | Low | `lib/paper.ts:30-34, 98-101` | Fills at `regularMarketPrice` at 3 a.m. Mixed `number`/`Decimal`. Unbounded `dollars` can overflow `NUMERIC(18,6)` and return a 500. → Queue orders outside RTH, model the spread, use Decimal throughout, cap the order size. |
| PERF-02 | Every page load re-computes everything | Performance | Medium | `app/page.tsx:46-60`, `app/layout.tsx` (`force-dynamic` globally) | ~13 queries plus a full portfolio-series replay per request, and the layout's DeskStatus and TickerTape on every page. → Materialize daily portfolio snapshots, cache with `unstable_cache`/tags, revalidate on writes. |
| ARC-03 | UI talks to the DB directly | Architecture | Medium | all `app/**/page.tsx` | No API contract, so a mobile app, third-party client or rate limiter cannot be added at one layer. → Typed API layer (OpenAPI via zod-to-openapi, or tRPC); pages call services, not `pool`. |
| ARC-04 | Raw `fetch` LLM clients duplicated | Maintainability | Low | `lib/llm.ts`, `lib/ai/providers.ts` | Two Anthropic clients with different retry and timeouts. → One provider abstraction (the official SDK or the Vercel AI SDK) with tool use, streaming and prompt caching for the chat's big tool list. |
| DOC-01 | README points outside the repo | Docs | Medium | `README.md:6-7` | `../README.md` and the "Build Guide" are not in the repository; there is no LICENSE, `.env.example` or architecture doc. → Add `docs/architecture.md` (with diagrams), ADRs, `.env.example`, LICENSE and a screenshot/GIF. |
| UX-01 | Accessibility not verified | UX | Medium | `app/**` (sampled) | Labels exist on many inputs (~71 aria/label attributes), but streaming progress regions have no `aria-live`, and there is no automated a11y check. → axe in Playwright, `aria-live="polite"` on run logs, keyboard pass on Nav and the committee launcher. |
| UX-02 | Stale prices are not flagged | UX/Fin | Medium | `lib/holdings.ts:77-93` | Positions are valued at the latest `prices_daily` close however old, and fall back to cost when missing. → Show "as of" and a stale badge after N trading days. |

### P3 — refinements

| ID | Issue | Location | Fix |
|---|---|---|---|
| L-01 | `parseBasket` keeps the first 25 tickers but normalizes weights by the total of all of them, so weights no longer sum to 1 | `lib/risk/engine.ts` `parseBasket` | Normalize after slicing |
| L-02 | Daily budgets reset at DB-session midnight (UTC in Docker) | `date_trunc('day', now())` everywhere | Use the user's time zone explicitly |
| L-03 | `@types/node-cron` v3 in prod deps; node-cron 4 ships its own types | `package.json` | Remove it |
| L-04 | `@types/node ^20`, running Node 24 | `package.json` | Pin `engines.node`, align `@types/node` |
| L-05 | Hard-coded tunables (`FEE = 1`, `MIN_GAP_MS`, alert thresholds, `HEADLINE_FRESH_HOURS`) | various | Move into the config module |
| L-06 | `ANTHROPIC_MODEL` override relabels "Claude Opus" seat | `models.json` | Separate env per seat |
| L-07 | Example MCP config embeds your absolute Windows path | `mcp/claude_desktop_config.example.json` | Use a placeholder |
| L-08 | Four near-identical migrate scripts | `scripts/migrate-*.ts` | Superseded by DB-01 |
| L-09 | `getSplits` swallows *all* errors as "no splits" | `lib/splits.ts:74` | Only catch `42P01` (undefined table) |
| L-10 | On-disk cache writes are not atomic | `lib/sec.ts:59` | Write to a temp file, then rename |
| L-11 | Dossier cache key changes with any new headline in a 200-row window, so cache hits are rare | `lib/agents.ts:315` | Key on top-N by recency plus labels, or a time bucket |
| L-12 | `chat` transcript is global; `DELETE /api/chat` wipes it for everyone | `lib/chat.ts:657` | Per-user conversations (SEC-01) |

---

## 3. Security review summary

| Area | Status |
|---|---|
| Secrets in repo/history | ✅ None found (`.env*` ignored; full `git log -p` scanned for key patterns). `.env.local` exists locally only. |
| SQL injection | ✅ All queries parameterized; only constant SQL fragments interpolated (`lib/ai/store.ts:236`). |
| XSS | ✅ React escaping; no `dangerouslySetInnerHTML` except a constant theme script; feed/link URLs filtered to http(s) (`lib/url.ts`, `lib/feeds.ts:185`). ⚠️ No CSP (SEC-02). |
| CSRF | ✅ Origin/Sec-Fetch-Site check plus JSON-only bodies on writes (`proxy.ts:89-107`). |
| SSRF | ✅ Outbound hosts are fixed; user input only reaches query strings via `encodeURIComponent`; EDGAR cache path validated. |
| DNS rebinding | ✅ Host allow-list. |
| AuthN/AuthZ/IDOR | ❌ SEC-01, SEC-03, SEC-06. |
| Rate limiting | ⚠️ Daily budgets only; no per-IP/per-user limits; fail-open config (CFG-01). |
| LLM safety | ⚠️ Good "data not instructions" prompt, but enforcement is prompt-only (AI-01). |
| Logging of sensitive data | ✅/⚠️ Little logging at all; prompts with portfolio context are stored in `model_calls.raw_text` without retention. |
| Dependencies | ⚠️ SEC-04. |
| Webhooks / file uploads / OAuth | N/A today. Each will need signature verification, size/type limits and PKCE when added (see §4). |

---

## 4. Investment-platform integration readiness

Facts checked against public docs on 2026-10-06. Never scrape or reverse-engineer private APIs. The unofficial Wealthsimple libraries (`ws-api`, `wsimple`) call its internal GraphQL API and violate its terms.

| Platform | Official public API? | Auth | Data | Trading | Verdict for CapitalOS |
|---|---|---|---|---|---|
| **Wealthsimple** | **No** public developer API. A "Public API" is listed as an in-progress initiative in a 2026 job posting ([openbankingtracker](https://openbankingtracker.com/provider/wealthsimple/apis), [job post](https://www.builtinaustin.com/job/staff-product-manager-connectivity-platform/11004896)) | n/a directly | — | — | Reach it via an **aggregator**: SnapTrade lists Wealthsimple as *Read and Trade* ([SnapTrade guide](https://docs.snaptrade.com/docs/broker-access-guide)); Wealthica as read-only ([Wealthica](https://wealthica.com/investment-api/)). |
| **Blossom** | **No.** Blossom is a social investing app, not a broker; it links brokerages through **SnapTrade**, read-only ([College Investor review](https://thecollegeinvestor.com/67038/blossom-social-review/)) | — | — | — | Integrating "with Blossom" is not possible. Integrate the same way Blossom does: SnapTrade. |
| **Questrade** | **Yes**, official REST API ([docs](https://www.questrade.com/api/home)) | OAuth 2.0; personal apps via API Centre | Accounts, positions, balances, executions, market data | **Partner developers only**; personal tokens are read-only ([getting started](https://questrade.com/api/documentation/getting-started)) | Good first *direct* integration: read-only, OAuth, Canadian. |
| **Interactive Brokers** | **Yes**, Web API (Client Portal) and TWS API ([Web API docs](https://www.interactivebrokers.com/campus/ibkr-api-page/webapi-doc/)) | OAuth 1.0a for third parties (compliance approval required); OAuth 2.0 beta first-party; IBKR Pro, funded account | Full | Yes | Best for real trading, at a heavy onboarding cost. Start with the first-party gateway for your own account. |
| **Alpaca** | **Yes** ([OAuth docs](https://docs.alpaca.markets/docs/using-oauth2-and-trading-api)) | OAuth 2.0 (live and/or paper) | Account, positions, orders, market data | Yes; **paper trading free and open globally** | **Recommended trading target** for the showcase: replace `lib/paper.ts`'s simulated fills with Alpaca paper orders. Live-account eligibility for Canadian residents was not confirmed in the docs I found, so verify before promising it. |
| **SnapTrade** | **Yes** (aggregator) | Per-user connection portal; you never see broker credentials | Holdings, balances, transactions across ~25 brokers | Wealthsimple, Webull CA, others *Read and Trade*; Questrade, IBKR *read-only* via SnapTrade | **Recommended primary aggregation provider** (covers Wealthsimple and Questrade, and is what Blossom uses). |
| **Wealthica** | **Yes** (aggregator, 150+ Canadian institutions) | SDK / Connect widget | Holdings, transactions | No | Alternative or secondary Canadian read-only provider; pricing via sales. |
| **Plaid Investments** | Yes | Plaid Link | Holdings, transactions | No | Canadian coverage is bank-centric; investment-account coverage for Canadian brokers is weaker ([Wealthica comparison](https://wealthica.com/blog/plaid-vs-wealthica/)). Use for US brokerages. |
| **Market data** | Licensed: Polygon/Massive, Tiingo, Twelve Data, Alpaca Data, FMP. Free official: SEC EDGAR (already used), FRED (already used) | API key | Prices, corporate actions, dividends | — | Replace Yahoo (DATA-01). |

**Regulatory and security considerations (Canada first, as the obvious market):**
- Canada's **Consumer-Driven Banking** regulations (Bank of Canada oversight, accreditation-first rollout) were published in draft in 2026. Registered investment accounts may be phased in later ([Bennett Jones](https://www.bennettjones.com/Insights/Blogs/2026/07/Canada-Advances-Consumer-Driven-Banking-Framework-with-Proposed-Regulations)). Design consent records and scopes now so an accredited path is a swap of adapter.
- Use read-only scopes by default. Order placement must be a separate, explicit, per-order human confirmation. **Never** let an LLM tool place a live order.
- Placing trades for others or giving personalised recommendations is regulated (CIRO and provincial securities regulators in Canada; SEC/FINRA in the US). Keep the product as "research tool + user-initiated orders on the user's own account". Keep "not advice" disclosures. Do not market verdicts as recommendations.
- Privacy: PIPEDA (Canada) and state privacy laws. Store minimal PII, keep consent logs, provide deletion and export.
- Tokens: encrypt per-user OAuth/connection tokens at rest (envelope encryption with KMS), never log them, rotate them, and verify webhook signatures (SnapTrade and Alpaca both use signed webhooks or polling).

**Architecture changes needed before any broker integration:**
1. SEC-01 (users, owner-scoped data, sessions).
2. A `BrokerageProvider` port: `listAccounts`, `listPositions`, `listTransactions(since)`, `placeOrder?` (capability-flagged), and `getConnectionStatus`.
3. Tables: `brokerage_connections` (provider, encrypted token reference, scopes, status, `last_synced_at`), `external_accounts`, `external_positions_snapshot`, and `external_transactions` (with provider transaction ID UNIQUE, so imports are idempotent).
4. A reconciliation job that imports external transactions into the event-sourced ledger (FIN-01), deduplicates them by provider ID, and flags breaks between imported positions and computed positions.
5. A webhook receiver with signature verification, replay protection (timestamp + nonce table) and enqueue-only handling (no work in the request).
6. Multi-currency support (FIN-01) is a prerequisite for Canadian accounts.

---

## 5. Portfolio-level assessment (how reviewers will read it)

- **Senior / backend engineer:** The domain modelling and AI-grounding ideas are genuinely strong. Red flags: there are no tests, logic is coupled to `pool`, requests run for 13 minutes, and the ledger has a correctness hole.
- **Security engineer:** Thoughtful local hardening, but no identity model. That is the first question for anything that holds "financial data".
- **Cloud engineer:** It cannot be deployed as-is: no container, a writable-cwd cache, in-memory state, loopback binding, no IaC.
- **FinTech engineer:** Scraped Yahoo data, no cash/FX/dividends, a non-standard return metric, and the split bug in the backtester. These are the things a FinTech interviewer probes first.
- **Recruiter:** Impressive README voice and feature breadth, but no CI badge, no live demo, no screenshots, and docs that point outside the repo.

**Highest-signal improvements (each demonstrates real depth):**
1. **Correct, event-sourced, multi-currency ledger** with TWR/MWR, corporate actions, reconciliation and an audit log. *Shows: financial systems, databases.*
2. **Durable job system** (pg-boss) for committees, ingestion and broker sync, with idempotency, retries, a dead-letter queue and progress over SSE. *Shows: distributed systems.*
3. **Real auth + RLS multi-tenancy** with threat model documentation. *Shows: security.*
4. **Provider ports and adapters** for market data, news, brokerage and LLM, with contract tests against recorded fixtures. *Shows: clean architecture and testability.*
5. **SnapTrade (read) + Alpaca paper (trade) integrations** with signed webhooks and encrypted tokens. *Shows: real integrations done legitimately.*
6. **LLM evaluation harness:** a golden set of claims with known verdicts for the fact checker, regression scores in CI, cost and latency dashboards. *Shows: AI engineering rigor beyond prompting.*
7. **Observability + SLOs:** OTel traces across web, worker, DB and provider, with a Grafana dashboard screenshot in the README. *Shows: production thinking.*
8. **CI/CD + IaC:** GitHub Actions → container registry → Fly/Render or AWS ECS + RDS with Terraform, preview environments, migrations gated in the pipeline. *Shows: DevOps.*

Avoid adding more AI personas, more feeds or more pages until 1–4 exist. Breadth is already ahead of depth.

---

## 6. Testing audit

**Current:** `scripts/selftest-{consensus,risk,strategy}.ts`. These are assertion scripts that need a live database (and Yahoo for two of them). There is no runner, coverage, CI, e2e or fixture data.

**Highest-value tests to add (in order):**
1. **Ledger property tests** (fast-check on `buildPosition`, `heldQuantity`, splits): position never negative, cost basis conserved across splits, realized + unrealized reconciles. Include the LED-01 backdated-sell case as a failing test first.
2. **Backtest point-in-time tests:** facts are invisible before `filed_at`; restatements are applied from their own filing date; **split-basis market cap** (BT-01) on synthetic data.
3. **Fact-checker golden set:** about 100 labelled claims covering units, direction, miscitation, semantic mismatch (AI-03) and small numbers.
4. **API integration tests** (Testcontainers Postgres + MSW): `/api/transactions` validation and concurrency (two parallel sells), `/api/paper` cash check under concurrency, budget exhaustion (including a NaN env value), committee run status transitions (AI-02).
5. **Proxy security tests:** wrong host → 421, missing or wrong token → 401, cross-origin POST → 403, non-JSON body → 415, token query → cookie + redirect strips the token.
6. **LLM tool-guard tests:** a scripted model response requesting `research_ticker` for a ticker that is not in the user's message must be refused (AI-01).
7. **Migration test:** apply all migrations to an empty database and to a snapshot of the current schema; `VALIDATE CONSTRAINT` succeeds.
8. **Provider contract tests** with recorded fixtures (Yahoo / replacement, EDGAR companyfacts, GDELT notice body, Anthropic error and `max_tokens` responses).
9. **E2E (Playwright):** add a transaction → see the position; run a fast committee with a stubbed provider; paper order; axe accessibility scan per page.
10. **Failure-mode tests:** DB restart mid-request (OPS-01), provider 529 with retry-after, malformed RSS, GDELT throttle text.

---

## 7. Dependency audit

| Item | Finding | Action |
|---|---|---|
| `@modelcontextprotocol/sdk` 1.30.0 | High advisory (client OAuth; not reachable here) | Upgrade to ≥1.31 (1.32.1 latest) |
| `sharp` (transitive via next) | High advisory | `npm audit fix` / Next 16.4 |
| `eslint-config-next` → `braces` | High, dev-only | Wait for upstream or override `braces` |
| `@types/node-cron` in `dependencies` | Unneeded (node-cron 4 bundles types) and in the wrong section | Remove |
| `@types/node ^20` vs Node 24 runtime | Type/runtime mismatch | Pin `engines`, use `@types/node@24` |
| `dotenv` | Needed only by scripts | Fine; or use `node --env-file` (Node ≥20.6) and drop it |
| `node-cron` | Replace with queue-scheduled jobs (ARC-01) | Remove later |
| `recharts` | Heavy but used | OK; lazy-load chart components |
| `decimal.js` | Good | Use consistently (paper trading uses floats) |
| Missing | zod env schema (already have zod), pino, test runner, pg-boss, an LLM SDK, Sentry | Add as the roadmap reaches them |
| Unused | None found among direct deps | — |

---

## 8. Roadmap

### Phase 1 — Critical fixes (1–2 weeks)
- LED-01: ledger validation over the full timeline, transactional writes, idempotency key, void/correct + audit rows.
- BT-01: split-consistent market cap in backtest, scoring, scanner and evidence, plus regression tests.
- OPS-01 / DB-03: pool error handler, timeouts, lock helper that runs on the locked client.
- CFG-01: zod-validated config with fail-closed budgets; `.env.example`.
- AI-02: committee status integrity; DB transaction around run finalization.
- SEC-04: `npm audit fix`.
- Stand up Vitest + GitHub Actions (lint, typecheck, unit) so every fix above lands with a test.

### Phase 2 — Production readiness (3–5 weeks)
- SEC-01/03: OIDC auth, users/accounts, `owner_id` + RLS, sessions, audit log, rate limiting.
- DB-01/02: real migrations, constraints validated, indexes, retention.
- ARC-01/02: pg-boss workers for committees, research, autopilot and ingestion; shared rate limiter; SSE progress.
- OPS-02: pino, OTel, Sentry, health checks, dashboards.
- SEC-02, AI-01, COST-01: CSP and headers, code-enforced tool guards and result caps, dollar budgets.
- DEP-01: Dockerfile, compose (web + worker + db), deploy target, Terraform, preview environments, migrations in CD.
- Integration and e2e test suites (§6 items 4–9).

### Phase 3 — Investment platform integrations (4–6 weeks)
- FIN-01: event-sourced multi-currency ledger, cash, dividends, corporate actions, TWR/MWR.
- DATA-01: `MarketDataProvider` with a licensed provider; Yahoo dev-only.
- `BrokerageProvider` port. **SnapTrade** read-only first (covers Wealthsimple and Questrade), then the **Questrade** direct OAuth adapter (read-only).
- Connection lifecycle, encrypted tokens (KMS), signed webhooks, idempotent imports and a reconciliation report.
- **Alpaca paper trading** as the order-execution adapter behind explicit human confirmation; LLM tools remain read-only.
- Consent records and data export/deletion (PIPEDA); disclosures.

### Phase 4 — Portfolio-level engineering (ongoing)
- Architecture doc with C4 diagrams, ADRs and a threat model (STRIDE) in `docs/`.
- LLM evaluation harness in CI (fact-checker golden set, committee regression on frozen evidence packs, cost/latency budgets).
- SLOs (e.g. 99% of ledger reads < 300 ms; committee job success ≥ 98%) with dashboards and screenshots in the README.
- Load test (k6) on read APIs; documented results.
- Public demo with seeded synthetic data and a demo login; CI, coverage and deploy badges.

### Phase 5 — Advanced features (optional)
- Real-time quotes over WebSocket from the licensed provider; streaming P/L.
- Portfolio analytics: attribution (Brinson), factor regression, tax-lot views (ACB for Canada, FIFO/spec-ID for US).
- Risk: Monte Carlo and historical-scenario VaR/CVaR, stress tests, rebalancing optimizer.
- Alerts delivered by email, push or webhook, with user-defined rules.
- Multi-agent research over a filing vector store (pgvector) with citations verified by the existing checker.
- Broker trading on IBKR (after third-party approval) or SnapTrade trade-enabled brokers, with order state machine, pre-trade risk checks and a kill switch.
