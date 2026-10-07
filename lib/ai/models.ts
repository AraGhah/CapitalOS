import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { pool } from "../db";
import { config } from "../config";

/* ---------------------------------------------------------------------------
   The model registry.

   models.json lists every model the committee may seat and which provider
   serves it. A model is available only when its provider's key is set and its
   model id resolves, so the line-up on any given machine is exactly the set of
   keys in .env.local — nothing is seated that cannot answer.

   Prices are optional and per million tokens. An unpriced model is still
   metered in tokens; its cost shows as unknown rather than as zero.
--------------------------------------------------------------------------- */

export type Tier = "fast" | "standard" | "frontier";

export interface ProviderConfig {
  kind: "anthropic" | "openai";
  baseUrl?: string;
  keyEnv: string;
  maxTokensParam?: "max_tokens" | "max_completion_tokens";
  jsonMode?: boolean;
  requestsPerMinute?: number;
}

const Price = z.number().min(0).nullable().optional();

const ModelEntrySchema = z.object({
  id: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1).optional(),
  modelEnv: z.string().min(1).optional(),
  label: z.string().min(1),
  tier: z.enum(["fast", "standard", "frontier"]),
  priceIn: Price,
  priceOut: Price,
  priceCacheRead: Price,
  priceCacheWrite: Price,
});

const ProviderSchema = z.object({
  kind: z.enum(["anthropic", "openai"]),
  baseUrl: z.string().url().optional(),
  keyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  maxTokensParam: z.enum(["max_tokens", "max_completion_tokens"]).optional(),
  jsonMode: z.boolean().optional(),
  requestsPerMinute: z.number().int().positive().optional(),
});

const RegistrySchema = z.object({
  pricesAsOf: z.string().optional(),
  providers: z.record(z.string(), ProviderSchema),
  models: z.array(ModelEntrySchema).min(1),
});

type ModelEntry = z.infer<typeof ModelEntrySchema>;

export interface ModelSpec {
  id: string;
  provider: string;
  providerConfig: ProviderConfig;
  model: string;
  label: string;
  tier: Tier;
  priceIn: number | null;
  priceOut: number | null;
  priceCacheRead: number | null;
  priceCacheWrite: number | null;
}

export interface RegistryRow {
  id: string;
  provider: string;
  label: string;
  tier: Tier;
  model: string | null;
  keyEnv: string;
  available: boolean;
  missing: string | null;
  priced: boolean;
  priceIn: number | null;
  priceOut: number | null;
}

interface Registry {
  providers: Record<string, ProviderConfig>;
  models: ModelEntry[];
}

// Validated when read, so a typo in models.json is a clear error rather than a
// seat that silently never answers. Re-read only when the file changes, so
// editing the line-up still needs no rebuild, without a synchronous file read
// on every model call.
let registryCache: { mtimeMs: number; registry: Registry } | null = null;

export function loadRegistry(): Registry {
  const path = join(process.cwd(), "models.json");
  const mtimeMs = statSync(path).mtimeMs;
  if (registryCache && registryCache.mtimeMs === mtimeMs) return registryCache.registry;
  const parsed = RegistrySchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) {
    throw new Error(`models.json is invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  for (const m of parsed.data.models) {
    if (!parsed.data.providers[m.provider]) throw new Error(`models.json: model "${m.id}" names unknown provider "${m.provider}"`);
  }
  registryCache = { mtimeMs, registry: parsed.data as Registry };
  return registryCache.registry;
}

function resolveModel(entry: ModelEntry): string | null {
  const fromEnv = entry.modelEnv ? process.env[entry.modelEnv]?.trim() : undefined;
  return fromEnv || entry.model || null;
}

export function listRegistry(): RegistryRow[] {
  const { providers, models } = loadRegistry();

  return models.map((entry) => {
    const provider = providers[entry.provider];
    const model = resolveModel(entry);
    const hasKey = provider ? Boolean(process.env[provider.keyEnv]?.trim()) : false;

    let missing: string | null = null;
    if (!provider) missing = `no provider "${entry.provider}" in models.json`;
    else if (!hasKey) missing = provider.keyEnv;
    else if (!model) missing = entry.modelEnv ?? "model id";

    return {
      id: entry.id,
      provider: entry.provider,
      label: entry.label,
      tier: entry.tier,
      model,
      keyEnv: provider?.keyEnv ?? "",
      available: missing === null,
      missing,
      priced: typeof entry.priceIn === "number" && typeof entry.priceOut === "number",
      priceIn: entry.priceIn ?? null,
      priceOut: entry.priceOut ?? null,
    };
  });
}

export function availableModels(): ModelSpec[] {
  const { providers, models } = loadRegistry();
  const out: ModelSpec[] = [];

  for (const entry of models) {
    const providerConfig = providers[entry.provider];
    const model = resolveModel(entry);
    if (!providerConfig || !model || !process.env[providerConfig.keyEnv]?.trim()) continue;

    out.push({
      id: entry.id,
      provider: entry.provider,
      providerConfig,
      model,
      label: entry.label,
      tier: entry.tier,
      priceIn: typeof entry.priceIn === "number" ? entry.priceIn : null,
      priceOut: typeof entry.priceOut === "number" ? entry.priceOut : null,
      priceCacheRead: typeof entry.priceCacheRead === "number" ? entry.priceCacheRead : null,
      priceCacheWrite: typeof entry.priceCacheWrite === "number" ? entry.priceCacheWrite : null,
    });
  }
  return out;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
}

// What a call cost, in dollars. Cache reads and writes are priced at their own
// rates when the registry has them (a read is a tenth of input, a write a
// quarter more), otherwise as plain input. A model with no price at all is
// charged UNPRICED_MODEL_USD_PER_MTOK on every token, and the cost is marked
// estimated: an unpriced model is never free against the budget.
export function costOf(spec: ModelSpec, usage: TokenUsage): { usd: number; estimated: boolean } {
  if (spec.priceIn === null || spec.priceOut === null) {
    const rate = config().UNPRICED_MODEL_USD_PER_MTOK;
    const tokens = usage.inputTokens + usage.outputTokens + usage.cachedTokens + usage.cacheWriteTokens;
    return { usd: (tokens * rate) / 1_000_000, estimated: true };
  }
  const read = spec.priceCacheRead ?? spec.priceIn;
  const write = spec.priceCacheWrite ?? spec.priceIn;
  const usd =
    (usage.inputTokens * spec.priceIn +
      usage.outputTokens * spec.priceOut +
      usage.cachedTokens * read +
      usage.cacheWriteTokens * write) /
    1_000_000;
  return { usd, estimated: false };
}

// The spec for an Anthropic model by its model id, for calls made outside the
// committee (the copilot, the analyst, the strategist), so they are priced too.
export function specForModel(provider: string, model: string): ModelSpec | null {
  return availableModels().find((m) => m.provider === provider && m.model === model) ?? null;
}

/* ---------------------------------------------------------------------------
   Routing.

   Every stage has a default preference by tier: the checker wants a cheap fast
   model, the judge and the synthesizer want the strongest one. Once a model has
   been graded on a stage enough times, its record overrides the default — the
   router learns which model is actually better at which job, and the grades are
   rows anyone can inspect on the AI page.
--------------------------------------------------------------------------- */

export type Stage =
  | "analyst"
  | "specialist"
  | "bull"
  | "bear"
  | "challenger"
  | "fact_check"
  | "judge"
  | "synthesizer";

const TIER_PREFERENCE: Record<Stage, Tier[]> = {
  analyst: ["frontier", "standard", "fast"],
  specialist: ["standard", "frontier", "fast"],
  bull: ["standard", "frontier", "fast"],
  bear: ["standard", "frontier", "fast"],
  challenger: ["frontier", "standard", "fast"],
  fact_check: ["fast", "standard", "frontier"],
  judge: ["frontier", "standard", "fast"],
  synthesizer: ["frontier", "standard", "fast"],
};

// Below this many graded runs a model's average is noise, and the tier default
// is the better guess.
export const MIN_GRADED_RUNS = 3;

export interface StageRecord {
  modelId: string;
  stage: string;
  runs: number;
  overall: number;
}

export async function stageRecords(): Promise<StageRecord[]> {
  try {
    const { rows } = await pool.query(
      `SELECT model_id, stage, count(*)::int AS runs, avg(overall)::float AS overall
       FROM model_evaluations
       WHERE overall IS NOT NULL
       GROUP BY model_id, stage`
    );
    return rows.map((r) => ({
      modelId: r.model_id,
      stage: r.stage,
      runs: r.runs,
      overall: r.overall,
    }));
  } catch {
    // The consensus tables are not migrated yet; routing falls back to tiers.
    return [];
  }
}

export function rankForStage(
  stage: Stage,
  candidates: ModelSpec[],
  records: StageRecord[]
): ModelSpec[] {
  const tierOrder = TIER_PREFERENCE[stage];
  const graded = new Map(
    records
      .filter((r) => r.stage === stage && r.runs >= MIN_GRADED_RUNS)
      .map((r) => [r.modelId, r.overall])
  );

  return [...candidates].sort((a, b) => {
    const ga = graded.get(a.id);
    const gb = graded.get(b.id);
    if (ga !== undefined && gb !== undefined && ga !== gb) return gb - ga;
    if (ga !== undefined && gb === undefined) return -1;
    if (gb !== undefined && ga === undefined) return 1;
    return tierOrder.indexOf(a.tier) - tierOrder.indexOf(b.tier);
  });
}

// Picks the best model for a stage, preferring one not already used by the
// stages it will be judging — a model grading its own work is the anchoring the
// whole committee exists to avoid.
export function pickForStage(
  stage: Stage,
  candidates: ModelSpec[],
  records: StageRecord[],
  avoid: string[] = []
): ModelSpec {
  const ranked = rankForStage(stage, candidates, records);
  return ranked.find((m) => !avoid.includes(m.id)) ?? ranked[0];
}

// Different providers disagree for more interesting reasons than two sizes of
// the same model, so the analyst seats go to distinct providers first.
export function seatAnalysts(
  candidates: ModelSpec[],
  records: StageRecord[],
  seats: number
): ModelSpec[] {
  const ranked = rankForStage("analyst", candidates, records);
  const chosen: ModelSpec[] = [];
  const providers = new Set<string>();

  for (const model of ranked) {
    if (chosen.length >= seats) break;
    if (providers.has(model.provider)) continue;
    chosen.push(model);
    providers.add(model.provider);
  }
  for (const model of ranked) {
    if (chosen.length >= seats) break;
    if (!chosen.includes(model)) chosen.push(model);
  }
  return chosen;
}
