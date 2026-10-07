import { extractJson, inputHash } from "../llm";
import { availableModels, pickForStage, stageRecords } from "../ai/models";
import { callModel } from "../ai/providers";
import { renderEvidence, type EvidenceItem, type EvidencePack } from "../ai/evidence";
import { unsupportedFigures } from "../ai/factcheck";
import type { MarketOverview } from "./overview";
import type { Actor } from "../actor";
import { assertWithinSpend, recordModelCall } from "../ai/metering";

/* ---------------------------------------------------------------------------
   The market brief: a model explains what the overview's numbers show. It is
   given the computed moves and regime signals as an evidence pack, so the same
   figure checker that guards the committee guards this — a number the pack does
   not contain is flagged on the page rather than passed off as fact.

   Written only when asked for, and kept for an hour per set of numbers.
--------------------------------------------------------------------------- */

export interface MarketBrief {
  headline: string;
  summary: string;
  watch: string[];
  model: string;
  unverified: string[];
  writtenAt: string;
}

const CACHE_MS = 60 * 60_000;
const cache = new Map<string, { at: number; brief: MarketBrief }>();

export function overviewPack(o: MarketOverview): EvidencePack {
  const items: EvidenceItem[] = [];
  const add = (item: Omit<EvidenceItem, "id">) => items.push({ id: `E${items.length + 1}`, ...item });
  const src = { kind: "computed", ref: "provider daily closes, computed by lib/market" };

  for (const a of o.assets) {
    if (!a.m) continue;
    if (a.symbol === "^VIX") {
      add({ kind: "price", label: "VIX level", value: a.m.last, asOf: a.m.asOf, source: src });
      continue;
    }
    for (const [key, label] of [
      ["day", "1-day"],
      ["month", "1-month"],
      ["quarter", "3-month"],
      ["ytd", "year-to-date"],
    ] as const) {
      const v = a.m[key];
      if (v !== null) add({ kind: "price", label: `${a.label} (${a.symbol}) ${label} return`, value: v, unit: "ratio", asOf: a.m.asOf, source: src });
    }
  }
  for (const m of o.macro) {
    add({ kind: "macro", label: m.label, value: m.latest, unit: m.unit, asOf: m.asOf, source: { kind: "fred", ref: `FRED ${m.id}` } });
  }
  for (const s of o.signals) {
    add({ kind: "metric", label: `Regime signal — ${s.name}`, text: `${s.reading}. ${s.basis}`, source: { kind: "computed", ref: "regime rules in lib/market/overview" } });
  }
  add({
    kind: "metric",
    label: "Overall regime",
    text: `${o.regime.label}: ${o.regime.on} risk-on signals, ${o.regime.off} risk-off, ${o.regime.neutral} neutral`,
    source: { kind: "computed", ref: "regime rules" },
  });

  return {
    ticker: "MARKET",
    name: "US markets",
    sector: null,
    industry: null,
    generatedAt: new Date().toISOString(),
    periodEnd: null,
    items,
    coverage: { inputs: [], present: 0, expected: 0 },
    hash: inputHash(items),
  };
}

const INSTRUCTIONS = `ROLE: Market strategist
GOAL: Explain in plain words what is moving markets, using only the computed figures in the evidence pack.

RULES
- Every number you write must appear in the evidence pack. You may restate 0.052 as 5.2%. Never compute a new figure, never forecast.
- Say what the regime signals found and which moves stand out; name the assets.
- Distinguish what the numbers show from what they might mean.
- Reply with one JSON object and nothing else.

EXPECTED OUTPUT
{"headline": "one line, under 100 characters", "summary": "3-5 sentences", "watch": ["2-4 things worth watching, one sentence each"]}`;

export async function writeBrief(
  actor: Pick<Actor, "userId">,
  o: MarketOverview,
  force = false
): Promise<MarketBrief> {
  const pack = overviewPack(o);
  const hit = cache.get(pack.hash);
  if (!force && hit && Date.now() - hit.at < CACHE_MS) return hit.brief;

  const models = availableModels();
  if (models.length === 0) throw new Error("no model is configured — add ANTHROPIC_API_KEY to .env.local");
  const model = pickForStage("synthesizer", models, await stageRecords());

  await assertWithinSpend(actor.userId);
  const meta = { userId: actor.userId, purpose: "market-brief", stage: "synthesizer", agent: "Market strategist", modelId: model.id, provider: model.provider, model: model.model };
  let result;
  try {
    result = await callModel(model, {
      evidence: renderEvidence(pack),
      instructions: INSTRUCTIONS,
      user: "Write today's market brief.",
      maxTokens: 1200,
    });
  } catch (err) {
    await recordModelCall({ ...meta, error: (err as Error).message });
    throw err;
  }
  await recordModelCall({ ...meta, ...result, rawText: null });
  const raw = extractJson<{ headline?: string; summary?: string; watch?: unknown }>(result.text);
  const headline = typeof raw.headline === "string" ? raw.headline.trim() : "";
  const summary = typeof raw.summary === "string" ? raw.summary.trim() : "";
  const watch = Array.isArray(raw.watch) ? raw.watch.filter((w): w is string => typeof w === "string").slice(0, 4) : [];

  const brief: MarketBrief = {
    headline,
    summary,
    watch,
    model: model.label,
    unverified: [...new Set(unsupportedFigures([headline, summary, ...watch].join("\n"), pack))],
    writtenAt: new Date().toISOString(),
  };
  cache.set(pack.hash, { at: Date.now(), brief });
  return brief;
}
