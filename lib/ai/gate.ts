import { config } from "../config";
import { Semaphore, take, UPSTREAM } from "../ratelimit";

// Every model call passes through here: a token from the provider's shared
// per-minute bucket (all processes), then a slot in this process's
// concurrency limit. The committee's parallel seats run in parallel, up to
// both limits, instead of queueing behind a fixed four-second gap.
let local: Semaphore | null = null;

export async function gated<T>(provider: string, fn: () => Promise<T>): Promise<T> {
  const c = config();
  const perMinute = provider === "anthropic" ? c.ANTHROPIC_RPM : c.PROVIDER_RPM;
  await take(UPSTREAM.provider(provider, perMinute), 5 * 60_000);
  local ??= new Semaphore(c.LLM_CONCURRENCY);
  return local.run(fn);
}
