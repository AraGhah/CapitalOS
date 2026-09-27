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
npm run dev
```

`.env.local`:

| Variable | Needed for | Without it |
| --- | --- | --- |
| `DATABASE_URL` | everything | the app cannot start |
| `SEC_USER_AGENT` | EDGAR and GDELT politeness | a default contact string is sent |
| `ANTHROPIC_API_KEY` | the strategist's brief, and the chat | verdicts still come out, from the sentiment counts; the brief renders as missing and the chat is unavailable |
| `ANTHROPIC_MODEL` | overriding the model | `claude-opus-5` |
| `DAILY_DOSSIER_BUDGET` | capping spend | 40 pipeline runs per day, then runs stop |
| `OPENAI_API_KEY` | hosted embeddings for event clustering | local hashed-token vectors |
| `ALPHA_VANTAGE_API_KEY` | `fetch-prices` | use `fetch-prices-yahoo` instead, which needs no key |

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

A dossier is cached on a hash of the exact headline set and labels it was built
from, so an unchanged company is never re-analysed or re-billed.

## Not financial advice

Every verdict is a summary of public news. Verify anything here before acting on it.
