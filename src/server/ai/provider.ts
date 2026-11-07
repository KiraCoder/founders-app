/**
 * The AI provider layer. **No provider has been chosen** (the founders decide; see the
 * brief), so the only implementation is `NoneProvider`, which refuses with the typed error
 * `ai_provider_not_configured`. Nothing in this app makes an LLM network call today.
 *
 * Everything that uses AI must work without it: the AI roles analyse deterministically and
 * treat the narrative as an optional layer that is skipped while `AI_PROVIDER` is `none`.
 *
 * How a provider plugs in later (a developer task, after the founders choose one):
 * 1. write a class implementing `LlmProvider` in its own file under src/server/ai/providers/;
 * 2. register it in `PROVIDER_FACTORIES` below under a short id;
 * 3. set `AI_PROVIDER=<id>` and that provider's own key variable in the hosting dashboard
 *    (never in the repo).
 * No other code changes: callers only see `LlmProvider`.
 */

export interface LlmMessage {
  role: "user" | "assistant";
  content: string;
}

export interface LlmTool {
  name: string;
  description: string;
  /** JSON Schema of the tool's input. */
  inputSchema: Record<string, unknown>;
}

export interface LlmToolCall {
  name: string;
  input: unknown;
}

export interface LlmGenerateInput {
  system: string;
  messages: LlmMessage[];
  tools?: LlmTool[];
  maxTokens: number;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmGenerateResult {
  text: string;
  toolCalls?: LlmToolCall[];
  usage: LlmUsage;
}

export interface LlmProvider {
  /** Short id as written in AI_PROVIDER ("none", …). */
  readonly id: string;
  /** False for "none": callers skip AI work instead of calling generate(). */
  readonly configured: boolean;
  generate(input: LlmGenerateInput): Promise<LlmGenerateResult>;
}

export type AiProviderErrorCode = "ai_provider_not_configured" | "ai_provider_unknown";

/** Typed refusal from the provider layer (never a crash with a vendor-specific message). */
export class AiProviderError extends Error {
  constructor(
    public readonly code: AiProviderErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AiProviderError";
  }
}

export function isAiProviderError(err: unknown, code?: AiProviderErrorCode): err is AiProviderError {
  return err instanceof AiProviderError && (!code || err.code === code);
}

/** The default until the founders choose a provider: refuses every call, makes no network call. */
export class NoneProvider implements LlmProvider {
  readonly id = "none";
  readonly configured = false;
  constructor(private readonly reason = "No AI provider is chosen yet (AI_PROVIDER=none).") {}
  async generate(): Promise<LlmGenerateResult> {
    throw new AiProviderError("ai_provider_not_configured", this.reason);
  }
}

/** Implemented providers by id. Only "none" for now — see the header for how to add one. */
const PROVIDER_FACTORIES: Record<string, () => LlmProvider> = {
  none: () => new NoneProvider(),
};

export function implementedProviders(): string[] {
  return Object.keys(PROVIDER_FACTORIES);
}

export interface ProviderStatus {
  /** The value of AI_PROVIDER ("none" when empty). */
  requested: string;
  /** The provider actually used. */
  id: string;
  configured: boolean;
  /** Set when AI_PROVIDER names something that is not implemented. */
  problem: string | null;
}

function requestedId(env: Record<string, string | undefined>): string {
  return (env.AI_PROVIDER ?? "").trim().toLowerCase() || "none";
}

/**
 * The provider selected by `AI_PROVIDER` (default "none"). An unknown value never crashes
 * the app: it falls back to "none" and `providerStatus()` reports the problem.
 */
export function getLlmProvider(env: Record<string, string | undefined> = process.env): LlmProvider {
  const id = requestedId(env);
  const factory = PROVIDER_FACTORIES[id];
  if (factory) return factory();
  return new NoneProvider(`AI_PROVIDER=${id} is not implemented in this app; using none.`);
}

export function providerStatus(env: Record<string, string | undefined> = process.env): ProviderStatus {
  const requested = requestedId(env);
  const provider = getLlmProvider(env);
  return {
    requested,
    id: provider.id,
    configured: provider.configured,
    problem: PROVIDER_FACTORIES[requested] ? null : `AI_PROVIDER=${requested} is not implemented; the app uses none.`,
  };
}

/** Strict variant for callers that must not fall back (throws ai_provider_unknown). */
export function requireLlmProvider(env: Record<string, string | undefined> = process.env): LlmProvider {
  const id = requestedId(env);
  const factory = PROVIDER_FACTORIES[id];
  if (!factory) throw new AiProviderError("ai_provider_unknown", `AI_PROVIDER=${id} is not implemented`);
  return factory();
}
