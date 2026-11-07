/**
 * Minimal OpenAI Chat Completions client (plain fetch, tool calling, no streaming). `fetch` and
 * `sleep` are injectable so tests never touch the network. Every failure becomes an
 * `AssistantError` with a code and a founder-readable message; only the code is logged (never the
 * key, never message content).
 */
import type { AssistantConfig } from "./config";

export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ChatTool {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ChatTool[];
  max_completion_tokens: number;
  reasoning_effort?: string;
  temperature?: number;
  parallel_tool_calls?: boolean;
}

export interface ChatUsage {
  input: number;
  cached: number;
  output: number;
}

export interface ChatResult {
  message: { content: string | null; tool_calls?: ChatToolCall[] };
  finishReason: string | null;
  usage: ChatUsage;
}

export type AssistantErrorCode =
  | "not_configured"
  | "insufficient_quota"
  | "rate_limited"
  | "invalid_key"
  | "model_not_found"
  | "context_length"
  | "bad_request"
  | "timeout"
  | "server"
  | "network";

export class AssistantError extends Error {
  constructor(
    public readonly code: AssistantErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AssistantError";
  }
}

export const QUOTA_MESSAGE = "OpenAI account is out of credit — add money at platform.openai.com/settings/organization/billing, then try again.";

export function errorMessage(code: AssistantErrorCode, model: string): string {
  switch (code) {
    case "not_configured":
      return "AI not set up — add OPENAI_API_KEY in Vercel (see README).";
    case "insufficient_quota":
      return QUOTA_MESSAGE;
    case "rate_limited":
      return "OpenAI is busy, try again in a minute.";
    case "invalid_key":
      return "The OpenAI key in Vercel is invalid or revoked — replace OPENAI_API_KEY.";
    case "model_not_found":
      return `Model ${model} isn't available on this OpenAI account — change OPENAI_MODEL.`;
    case "context_length":
      return "That was too long for the AI. Clear the chat or ask a shorter question — nothing was saved.";
    case "timeout":
      return "The AI took too long to answer. Try again — nothing was saved.";
    case "server":
      return "OpenAI had a problem on its side. Try again in a minute — nothing was saved.";
    case "network":
      return "Couldn't reach OpenAI. Check the connection and try again — nothing was saved.";
    default:
      return "The AI couldn't answer that. Try rephrasing — nothing was saved.";
  }
}

interface OpenAiErrorBody {
  error?: { code?: string | null; type?: string | null; message?: string | null };
}

/** HTTP status + OpenAI error body → our code. Exported for tests. */
export function classify(status: number, body: OpenAiErrorBody | null): AssistantErrorCode {
  const e = body?.error ?? {};
  const code = String(e.code ?? "");
  const type = String(e.type ?? "");
  const msg = String(e.message ?? "");
  if (status === 429 || status === 402) {
    if (/insufficient_quota|billing_hard_limit|billing_not_active/.test(`${code} ${type}`) || /exceeded your current quota/i.test(msg)) return "insufficient_quota";
    return "rate_limited";
  }
  if (status === 401 || status === 403 || code === "invalid_api_key") return "invalid_key";
  if (status === 404 || code === "model_not_found") return "model_not_found";
  if (code === "context_length_exceeded" || /maximum context length|context_length/i.test(`${code} ${msg}`)) return "context_length";
  if (status === 408) return "timeout";
  if (status >= 500) return "server";
  return "bad_request";
}

export interface OpenAiDeps {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function once(cfg: AssistantConfig, req: ChatRequest, f: typeof fetch): Promise<{ ok: true; result: ChatResult } | { ok: false; code: AssistantErrorCode; retryAfterMs: number | null }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
  let res: Response;
  try {
    res = await f(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(req),
      signal: ctrl.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const aborted = (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) || ctrl.signal.aborted;
    return { ok: false, code: aborted ? "timeout" : "network", retryAfterMs: null };
  }
  try {
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as OpenAiErrorBody | null;
      const ra = Number(res.headers.get("retry-after"));
      return { ok: false, code: classify(res.status, body), retryAfterMs: Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 10_000) : null };
    }
    const body = (await res.json()) as {
      choices?: { message?: { content?: string | null; tool_calls?: ChatToolCall[] }; finish_reason?: string }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
    };
    const choice = body.choices?.[0];
    if (!choice?.message) return { ok: false, code: "bad_request", retryAfterMs: null };
    return {
      ok: true,
      result: {
        message: { content: choice.message.content ?? null, tool_calls: choice.message.tool_calls?.length ? choice.message.tool_calls : undefined },
        finishReason: choice.finish_reason ?? null,
        usage: {
          input: body.usage?.prompt_tokens ?? 0,
          cached: body.usage?.prompt_tokens_details?.cached_tokens ?? 0,
          output: body.usage?.completion_tokens ?? 0,
        },
      },
    };
  } catch {
    return { ok: false, code: ctrl.signal.aborted ? "timeout" : "server", retryAfterMs: null };
  } finally {
    clearTimeout(timer);
  }
}

/** One chat completion; a plain rate limit (not out-of-credit) is retried once after a short backoff. */
export async function chatCompletion(cfg: AssistantConfig, req: ChatRequest, deps: OpenAiDeps = {}): Promise<ChatResult> {
  if (!cfg.apiKey) throw new AssistantError("not_configured", errorMessage("not_configured", cfg.model));
  const f = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? realSleep;
  let r = await once(cfg, req, f);
  if (!r.ok && r.code === "rate_limited") {
    await sleep(r.retryAfterMs ?? 2000);
    r = await once(cfg, req, f);
  }
  if (r.ok) return r.result;
  console.warn(`[assistant] openai error: ${r.code}`);
  throw new AssistantError(r.code, errorMessage(r.code, cfg.model));
}
