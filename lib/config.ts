import { z } from "zod";

/* ---------------------------------------------------------------------------
   Configuration, parsed once and validated.

   Every setting the desk reads comes through here. A malformed value is a
   startup error, never a silent default: `Number("12/day")` is NaN, and a NaN
   budget compares false against every count, which used to switch the spend
   caps off without a word. Empty strings count as unset.
--------------------------------------------------------------------------- */

const count = (fallback: number) => z.coerce.number().int().min(0).default(fallback);
const money = (fallback: number) => z.coerce.number().min(0).finite().default(fallback);
const flagOf = (fallback: boolean) =>
  z
    .enum(["1", "0", "true", "false", "yes", "no", "on", "off"])
    .transform((v) => ["1", "true", "yes", "on"].includes(v))
    .default(fallback);
const flag = flagOf(false);
const list = z
  .string()
  .transform((v) => v.split(",").map((s) => s.trim()).filter(Boolean))
  .default([]);

const MODES = ["fast", "standard", "deep", "committee"] as const;
const FEEDS = ["gdelt", "google_news", "yahoo_finance", "hacker_news", "reddit"] as const;

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),

    DATABASE_URL: z.string().min(1).optional(),
    DATABASE_POOL_MAX: z.coerce.number().int().min(2).max(100).default(10),
    DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(1000).default(30_000),
    DATABASE_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(500).default(5_000),

    // Sessions are signed with this; required outside development.
    SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters").optional(),
    SESSION_DAYS: z.coerce.number().int().min(1).max(90).default(14),
    ALLOW_SIGNUP: flag,
    // TEMPORARY: skip sign-in and act as the legacy owner. Refused in production.
    AUTH_DISABLED: flag,
    CAPITALOS_ALLOWED_HOSTS: list,
    // Set when TLS terminates in front of the app, so cookies are always Secure.
    TRUST_PROXY: flag,

    SEC_USER_AGENT: z
      .string()
      .regex(/\S+@\S+\.\S+/, "SEC_USER_AGENT must include a contact e-mail, e.g. 'CapitalOS you@example.com'")
      .optional(),

    ANTHROPIC_API_KEY: z.string().min(1).optional(),
    ANTHROPIC_MODEL: z.string().min(1).default("claude-opus-5-5"),
    // A gateway or proxy in front of the Messages API; the API itself by default.
    ANTHROPIC_BASE_URL: z.string().url().default("https://api.anthropic.com"),
    OPENAI_API_KEY: z.string().min(1).optional(),

    DAILY_DOSSIER_BUDGET: count(40),
    DAILY_CONSENSUS_BUDGET: count(12),
    DAILY_CHAT_BUDGET: count(150),
    // Hard ceiling on metered model spend per user per day, in US dollars.
    DAILY_SPEND_USD_LIMIT: money(25),
    // Cost charged against the budget for a model with no price in models.json,
    // per million tokens, so an unpriced model is never free.
    UNPRICED_MODEL_USD_PER_MTOK: money(15),
    LLM_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
    // Requests per minute each provider allows this deployment, shared by every process.
    ANTHROPIC_RPM: z.coerce.number().int().min(1).default(50),
    PROVIDER_RPM: z.coerce.number().int().min(1).default(30),

    PAPER_STARTING_CAPITAL: money(100_000),
    PAPER_COMMISSION_USD: money(1),
    PAPER_SPREAD_BPS: money(5),

    AUTOPILOT_CRON_MINUTES: z.coerce.number().int().min(5).max(1440).default(30),
    AUTOPILOT_CONVENE: flag,
    AUTOPILOT_MAX_COMMITTEES: count(3),
    AUTOPILOT_MODE: z.enum(MODES).default("standard"),

    MARKET_DATA_PROVIDER: z.enum(["alpaca", "yahoo", "auto"]).default("auto"),
    ALPACA_API_KEY_ID: z.string().min(1).optional(),
    ALPACA_API_SECRET_KEY: z.string().min(1).optional(),
    ALPACA_DATA_FEED: z.enum(["iex", "sip"]).default("iex"),
    ALPACA_PAPER: flagOf(true),
    ALPHA_VANTAGE_API_KEY: z.string().min(1).optional(),

    NEWS_FEEDS: z
      .string()
      .transform((v) => v.split(",").map((s) => s.trim()).filter(Boolean))
      .pipe(z.array(z.enum(FEEDS)))
      .default(["gdelt", "google_news", "hacker_news"]),

    SNAPTRADE_CLIENT_ID: z.string().min(1).optional(),
    SNAPTRADE_CONSUMER_KEY: z.string().min(1).optional(),
    QUESTRADE_CLIENT_ID: z.string().min(1).optional(),
    QUESTRADE_REDIRECT_URI: z.string().min(1).optional(),
    // 32 bytes, base64: encrypts brokerage tokens at rest.
    TOKEN_ENCRYPTION_KEY: z.string().optional(),
    PUBLIC_BASE_URL: z.string().min(1).optional(),

    SENTRY_DSN: z.string().min(1).optional(),
    METRICS_TOKEN: z.string().min(24, "METRICS_TOKEN must be at least 24 characters").optional(),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().min(1).optional(),

    RETENTION_CHAT_DAYS: count(180),
    RETENTION_RAW_MODEL_TEXT_DAYS: count(30),

    // Which account the MCP server acts for. It never takes one from a caller.
    CAPITALOS_MCP_USER: z.string().email().optional(),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === "production" && !env.SESSION_SECRET) {
      ctx.addIssue({ code: "custom", path: ["SESSION_SECRET"], message: "SESSION_SECRET is required in production" });
    }
    if (env.NODE_ENV === "production" && env.AUTH_DISABLED) {
      ctx.addIssue({ code: "custom", path: ["AUTH_DISABLED"], message: "AUTH_DISABLED cannot be set in production" });
    }
    if (env.TOKEN_ENCRYPTION_KEY !== undefined && Buffer.from(env.TOKEN_ENCRYPTION_KEY, "base64").length !== 32) {
      ctx.addIssue({ code: "custom", path: ["TOKEN_ENCRYPTION_KEY"], message: "TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded" });
    }
    if (Boolean(env.ALPACA_API_KEY_ID) !== Boolean(env.ALPACA_API_SECRET_KEY)) {
      ctx.addIssue({ code: "custom", path: ["ALPACA_API_KEY_ID"], message: "set both ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY, or neither" });
    }
  });

export type Config = z.infer<typeof schema>;

export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`invalid configuration:\n  ${issues.join("\n  ")}`);
    this.name = "ConfigError";
  }
}

function clean(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    // `KEY =value` in a .env file is legal and leaves stray spaces behind.
    const k = key.trim();
    const v = value?.trim();
    if (v) out[k] = v;
  }
  return out;
}

export function parseConfig(env: Record<string, string | undefined>): Config {
  const result = schema.safeParse(clean(env));
  if (!result.success) {
    throw new ConfigError(result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`));
  }
  return result.data;
}

let cached: Config | null = null;

export function config(): Config {
  cached ??= parseConfig(process.env);
  return cached;
}

// Tests swap the environment between cases.
export function resetConfig(): void {
  cached = null;
}

export function requireDatabaseUrl(): string {
  const url = config().DATABASE_URL;
  if (!url) throw new ConfigError(["DATABASE_URL: required"]);
  return url;
}

export function secUserAgent(): string {
  const ua = config().SEC_USER_AGENT;
  if (!ua) {
    throw new ConfigError([
      "SEC_USER_AGENT: required before calling SEC or GDELT (SEC's fair-access policy asks for a real contact), e.g. 'CapitalOS you@example.com'",
    ]);
  }
  return ua;
}
