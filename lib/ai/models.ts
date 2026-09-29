import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pool } from "../db";

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
}

interface ModelEntry {
  id: string;
  provider: string;
  model?: string;
  modelEnv?: string;
  label: string;
  tier: Tier;
  priceIn?: number | null;
  priceOut?: number | null;
}

export interface ModelSpec {
  id: string;
  provider: string;
  providerConfig: ProviderConfig;
  model: string;
  label: string;
  tier: Tier;
  priceIn: number | null;
  priceOut: number | null;
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
}

interface Registry {
  providers: Record<string, ProviderConfig>;
  models: ModelEntry[];
}

// Read on every call, like weights.json, so editing the line-up needs no rebuild.
function loadRegistry(): Registry {
  const raw = readFileSync(join(process.cwd(), "models.json"), "utf8");
  return JSON.parse(raw) as Registry;
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
    });
  }
  return out;
}

export function costOf(spec: ModelSpec, inputTokens: number, outputTokens: number): number | null {
  if (spec.priceIn === null || spec.priceOut === null) return null;
  return (inputTokens * spec.priceIn + outputTokens * spec.priceOut) / 1_000_000;
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
