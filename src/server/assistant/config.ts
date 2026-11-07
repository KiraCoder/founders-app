/**
 * AI assistant settings, all from the environment (Vercel → Settings → Environment Variables).
 * Pure (no "server-only") so tests can build configs directly.
 *
 *   OPENAI_API_KEY        secret; without it the assistant is "not set up" and nothing breaks
 *   OPENAI_MODEL          default "gpt-5-mini" (change here or in Vercel)
 *   OPENAI_BASE_URL       default https://api.openai.com/v1 (an OpenAI-compatible proxy also works)
 *   OPENAI_REASONING_EFFORT  minimal | low | medium | high | off (default minimal for gpt-5 / o-models)
 *   AI_DAILY_LIMIT        requests per founder per day (default 200)
 *   AI_MAX_OUTPUT_TOKENS  cap per model call (default 700)
 *   AI_PRICE_IN / AI_PRICE_CACHED / AI_PRICE_OUT  USD per 1M tokens, for the cost estimate
 *                         (defaults: gpt-5-mini list prices 0.25 / 0.025 / 2.00)
 */

export const DEFAULT_MODEL = "gpt-5-mini";

export interface AssistantConfig {
  apiKey: string | null;
  model: string;
  baseUrl: string;
  reasoningEffort: string | null;
  /** Sent only to models that accept it (not gpt-5 / o-series). */
  temperature: number | null;
  dailyLimit: number;
  perMinute: number;
  maxOutputTokens: number;
  /** Model calls per founder message (tool loop). */
  maxSteps: number;
  timeoutMs: number;
  price: { input: number; cached: number; output: number };
}

function num(v: string | undefined, fallback: number, min = 0): number {
  const n = Number(v);
  return v !== undefined && v.trim() !== "" && Number.isFinite(n) && n >= min ? n : fallback;
}

/** gpt-5*, o1/o3/o4…: reasoning models (reasoning_effort, no temperature). */
export function isReasoningModel(model: string): boolean {
  return /^(gpt-5|o\d)/i.test(model.trim());
}

export function assistantConfig(env: Record<string, string | undefined> = process.env): AssistantConfig {
  const model = env.OPENAI_MODEL?.trim() || DEFAULT_MODEL;
  const reasoning = isReasoningModel(model);
  const effortRaw = env.OPENAI_REASONING_EFFORT?.trim().toLowerCase();
  const effort = effortRaw === "off" ? null : effortRaw || (reasoning ? "minimal" : null);
  return {
    apiKey: env.OPENAI_API_KEY?.trim() || null,
    model,
    baseUrl: (env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1").replace(/\/+$/, ""),
    reasoningEffort: reasoning ? effort : null,
    temperature: reasoning ? null : 0.2,
    dailyLimit: Math.floor(num(env.AI_DAILY_LIMIT, 200, 1)),
    perMinute: 8,
    maxOutputTokens: Math.floor(num(env.AI_MAX_OUTPUT_TOKENS, 700, 100)),
    maxSteps: 4,
    timeoutMs: 45_000,
    price: { input: num(env.AI_PRICE_IN, 0.25), cached: num(env.AI_PRICE_CACHED, 0.025), output: num(env.AI_PRICE_OUT, 2) },
  };
}

/** USD for these token counts (cached tokens are part of `input`). */
export function estimateCost(cfg: Pick<AssistantConfig, "price">, t: { input: number; cached: number; output: number }): number {
  const fresh = Math.max(t.input - t.cached, 0);
  return (fresh * cfg.price.input + t.cached * cfg.price.cached + t.output * cfg.price.output) / 1_000_000;
}

export const NOT_SET_UP = "AI not set up — add OPENAI_API_KEY in Vercel (see README).";
