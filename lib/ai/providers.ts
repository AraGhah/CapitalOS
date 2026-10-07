import { fetchWithRetry, readJson } from "../http";
import { gated } from "./gate";
import { costOf, type ModelSpec } from "./models";

/* ---------------------------------------------------------------------------
   One call shape for every provider.

   Two adapters cover the whole registry: Anthropic's Messages API, and the
   OpenAI-compatible chat endpoint that OpenAI, Gemini, xAI, DeepSeek and
   OpenRouter all serve. Every call comes back metered — tokens in, tokens out,
   tokens served from cache, latency, and a price when the model has one — so
   the run ledger is written from what the provider reported, not estimated.

   The evidence pack goes first and is marked cacheable. Every seat on the
   committee reads the same pack, so after the first call it is billed at the
   cache rate instead of in full each time.
--------------------------------------------------------------------------- */

export interface ModelRequest {
  // Identical across every call of a run, so it is the cached prefix.
  evidence: string;
  // The role's instructions, which differ per seat.
  instructions: string;
  user: string;
  maxTokens: number;
}

export interface ModelResult {
  text: string;
  // uncached input; cache reads and writes are counted separately
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  latencyMs: number;
  costUsd: number;
  // true when the model has no listed price and the fallback rate was used
  costEstimated: boolean;
}

const TIMEOUT_MS = 180_000;

export async function callModel(spec: ModelSpec, req: ModelRequest): Promise<ModelResult> {
  const apiKey = process.env[spec.providerConfig.keyEnv]?.trim();
  if (!apiKey) throw new Error(`${spec.providerConfig.keyEnv} is not set`);

  // Each provider has its own account limit, shared by every process; one
  // provider's queue never slows another's.
  let started = 0;
  const usage = await gated(spec.provider, () => {
    started = Date.now();
    return spec.providerConfig.kind === "anthropic"
      ? callAnthropic(spec, apiKey, req)
      : callOpenAiCompatible(spec, apiKey, req);
  });

  const cost = costOf(spec, usage);
  return {
    ...usage,
    latencyMs: Date.now() - started,
    costUsd: cost.usd,
    costEstimated: cost.estimated,
  };
}

/* ----------------------------------------------------------------- Anthropic */

interface AnthropicBody {
  content?: Array<{ type: string; text?: string }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  error?: { message?: string };
}

async function callAnthropic(
  spec: ModelSpec,
  apiKey: string,
  req: ModelRequest
): Promise<Omit<ModelResult, "latencyMs" | "costUsd" | "costEstimated">> {
  const res = await fetchWithRetry("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: spec.model,
      max_tokens: req.maxTokens,
      system: [
        { type: "text", text: req.evidence, cache_control: { type: "ephemeral" } },
        { type: "text", text: req.instructions },
      ],
      messages: [{ role: "user", content: req.user }],
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const body = await readJson<AnthropicBody>(res);
  if (!res.ok || !body) {
    throw new Error(`${spec.label} request failed: ${res.status} ${body?.error?.message ?? res.statusText}`.trim());
  }

  return {
    text: (body.content ?? [])
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n")
      .trim(),
    inputTokens: body.usage?.input_tokens ?? 0,
    outputTokens: body.usage?.output_tokens ?? 0,
    cachedTokens: body.usage?.cache_read_input_tokens ?? 0,
    cacheWriteTokens: body.usage?.cache_creation_input_tokens ?? 0,
  };
}

/* ---------------------------------------------------------- OpenAI-compatible */

interface ChatBody {
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
  error?: { message?: string } | string;
}

async function callOpenAiCompatible(
  spec: ModelSpec,
  apiKey: string,
  req: ModelRequest
): Promise<Omit<ModelResult, "latencyMs" | "costUsd" | "costEstimated">> {
  const config = spec.providerConfig;
  const base = (config.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");

  const payload: Record<string, unknown> = {
    model: spec.model,
    messages: [
      // One system message with the evidence first: providers that cache
      // automatically do it on the longest shared prefix.
      { role: "system", content: `${req.evidence}\n\n${req.instructions}` },
      { role: "user", content: req.user },
    ],
    [config.maxTokensParam ?? "max_tokens"]: req.maxTokens,
  };
  if (config.jsonMode) payload.response_format = { type: "json_object" };

  const res = await fetchWithRetry(`${base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const body = await readJson<ChatBody>(res);
  if (!res.ok || !body) {
    const message = typeof body?.error === "string" ? body.error : body?.error?.message;
    throw new Error(`${spec.label} request failed: ${res.status} ${message ?? res.statusText}`.trim());
  }

  const cached = body.usage?.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    text: body.choices?.[0]?.message?.content?.trim() ?? "",
    inputTokens: Math.max(0, (body.usage?.prompt_tokens ?? 0) - cached),
    outputTokens: body.usage?.completion_tokens ?? 0,
    cachedTokens: cached,
    cacheWriteTokens: 0,
  };
}
