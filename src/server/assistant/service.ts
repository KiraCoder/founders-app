import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, asc, desc, eq, gt, gte, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { isoWeekday } from "@/lib/dates";
import { WEEKDAYS_EN } from "@/lib/routines";
import { assistantActions, assistantMessages, assistantUsage, type AssistantAction, type AssistantMessage } from "@/server/db/schema";
import { today, type ServiceContext } from "@/server/services/context";
import { ServiceError } from "@/server/services/errors";
import { listCompanies } from "@/server/services/companies";
import { listFounders } from "@/server/services/people";
import { findTool } from "@/server/mcp/all-tools";
import { toolErrorMessage, type ActionPreview, type ToolEnv } from "@/server/mcp/registry";
import { assistantConfig, estimateCost, NOT_SET_UP, type AssistantConfig } from "./config";
import { AssistantError, chatCompletion, errorMessage, QUOTA_MESSAGE, type ChatMessage, type ChatRequest, type OpenAiDeps } from "./openai";
import { contextMessage, STATIC_PROMPT } from "./prompt";
import { assistantTools, compactResult, routeTools } from "./router";
import { parseLocalCommand, runLocalCommand } from "./local";

/**
 * The in-app AI assistant: one chat per founder, stored in assistant_messages.
 *
 * - Founders only. Every tool runs through the shared registry as the asking founder, so the
 *   services' access rules apply (private todos: only the asker's own; salaries: never read).
 * - Writes are never executed by the model. A write tool call only PREPARES a plan, stored in
 *   assistant_actions with a one-time token (SHA-256 stored); the panel shows a card, and only
 *   `decideAction` with that token, by the same founder, while pending, runs the plan.
 * - Costs: a small fixed prompt first (cache-friendly), only the routed tools, compact tool
 *   results, the last few turns, capped output and steps, a daily request limit per founder,
 *   and simple commands answered locally. Token counts (never content) go to assistant_usage.
 */

export interface AssistantDeps extends OpenAiDeps {
  env?: Record<string, string | undefined>;
  baseUrl: string;
}

export interface ActionView {
  id: string;
  tool: string;
  title: string;
  fields: ActionPreview["fields"];
  confirm: string;
  status: string;
  result: string | null;
  /** Only in the response that created the card (the client keeps it for the click). */
  token?: string;
}

export interface ChatMessageView {
  id: string;
  role: "user" | "assistant" | "action" | "error" | "cmd" | "local";
  text: string;
  createdAt: string;
  action?: ActionView;
}

export interface ChatState {
  configured: boolean;
  model: string;
  notice: string | null;
  messages: ChatMessageView[];
}

const HISTORY_TURNS = 8;
const MAX_INPUT_CHARS = 2000;
const ACTION_TTL_MS = 30 * 60_000;
const SHOWN_MESSAGES = 100;

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

function assertFounder(ctx: ServiceContext) {
  if (ctx.user.role !== "founder") throw new ServiceError("forbidden", "Only the founders can use the assistant");
}

function actionView(a: AssistantAction, now: Date, token?: string): ActionView {
  const p = a.preview as ActionPreview;
  const status = a.status === "pending" && a.expiresAt.getTime() <= now.getTime() ? "expired" : a.status;
  return { id: a.id, tool: a.tool, title: p.title, fields: p.fields, confirm: p.confirm, status, result: a.result, ...(token ? { token } : {}) };
}

function messageView(m: AssistantMessage, actions: Map<string, AssistantAction>, now: Date, tokens: Map<string, string> = new Map()): ChatMessageView {
  const a = m.actionId ? actions.get(m.actionId) : undefined;
  return {
    id: m.id,
    role: m.role as ChatMessageView["role"],
    text: m.content,
    createdAt: m.createdAt.toISOString(),
    ...(a ? { action: actionView(a, now, tokens.get(a.id)) } : {}),
  };
}

async function viewsOf(ctx: ServiceContext, rows: AssistantMessage[], tokens?: Map<string, string>): Promise<ChatMessageView[]> {
  const ids = rows.map((r) => r.actionId).filter((x): x is string => !!x);
  const acts = ids.length ? await ctx.db.select().from(assistantActions).where(and(eq(assistantActions.userId, ctx.user.id), inArray(assistantActions.id, ids))) : [];
  const map = new Map(acts.map((a) => [a.id, a]));
  return rows.map((r) => messageView(r, map, ctx.now, tokens));
}

/** Is the OpenAI account out of credit (the last request ended with insufficient_quota)? */
export async function quotaProblem(ctx: ServiceContext): Promise<boolean> {
  const [last] = await ctx.db.select({ error: assistantUsage.error }).from(assistantUsage).orderBy(desc(assistantUsage.createdAt)).limit(1);
  return last?.error === "insufficient_quota";
}

export async function getChat(ctx: ServiceContext, deps: Pick<AssistantDeps, "env"> = {}): Promise<ChatState> {
  assertFounder(ctx);
  const cfg = assistantConfig(deps.env);
  const rows = await ctx.db
    .select()
    .from(assistantMessages)
    .where(eq(assistantMessages.userId, ctx.user.id))
    .orderBy(desc(assistantMessages.createdAt), desc(assistantMessages.id))
    .limit(SHOWN_MESSAGES);
  rows.reverse();
  const notice = !cfg.apiKey ? NOT_SET_UP : (await quotaProblem(ctx)) ? QUOTA_MESSAGE : null;
  return { configured: !!cfg.apiKey, model: cfg.model, notice, messages: await viewsOf(ctx, rows) };
}

export async function clearChat(ctx: ServiceContext): Promise<void> {
  assertFounder(ctx);
  await ctx.db.delete(assistantMessages).where(eq(assistantMessages.userId, ctx.user.id));
  await ctx.db.update(assistantActions).set({ status: "cancelled", decidedAt: ctx.now }).where(and(eq(assistantActions.userId, ctx.user.id), eq(assistantActions.status, "pending")));
}

/** Messages are ordered by created_at; one request writes several, so each gets its own instant. */
function clock(ctx: ServiceContext) {
  let t = ctx.now.getTime();
  return () => new Date(t++);
}

async function addMessage(ctx: ServiceContext, at: () => Date, role: ChatMessageView["role"], content: string, actionId: string | null = null): Promise<AssistantMessage> {
  const [row] = await ctx.db.insert(assistantMessages).values({ userId: ctx.user.id, role, content, actionId, createdAt: at() }).returning();
  return row!;
}

// ---------------------------------------------------------------------------
// History → model messages (trimmed)
// ---------------------------------------------------------------------------

function actionLine(a: AssistantAction | undefined, now: Date): string {
  if (!a) return "[card removed]";
  const v = actionView(a, now);
  const what = v.fields.slice(0, 3).map((f) => `${f.label}: ${f.value.split("\n")[0]}`).join("; ");
  return `[card ${v.tool} (${what}) — ${v.status}${v.result ? `: ${v.result.split("\n")[0]}` : ""}]`;
}

/** Last HISTORY_TURNS user turns (with their replies and cards); older user asks become one line. */
export async function historyForModel(ctx: ServiceContext, before?: Date): Promise<{ messages: ChatMessage[]; earlier: string | null }> {
  const rows = await ctx.db
    .select()
    .from(assistantMessages)
    .where(and(eq(assistantMessages.userId, ctx.user.id), inArray(assistantMessages.role, ["user", "assistant", "action"]), before ? sql`${assistantMessages.createdAt} < ${before}` : undefined))
    .orderBy(desc(assistantMessages.createdAt), desc(assistantMessages.id))
    .limit(80);
  rows.reverse();
  const userIdx = rows.map((r, i) => (r.role === "user" ? i : -1)).filter((i) => i >= 0);
  const cut = userIdx.length > HISTORY_TURNS ? userIdx[userIdx.length - HISTORY_TURNS]! : 0;
  const older = rows.slice(0, cut).filter((r) => r.role === "user");
  const recent = rows.slice(cut);
  const ids = recent.map((r) => r.actionId).filter((x): x is string => !!x);
  const acts = ids.length ? await ctx.db.select().from(assistantActions).where(inArray(assistantActions.id, ids)) : [];
  const map = new Map(acts.map((a) => [a.id, a]));
  const messages: ChatMessage[] = recent.map((r) =>
    r.role === "user" ? { role: "user", content: r.content } : { role: "assistant", content: r.role === "action" ? actionLine(map.get(r.actionId!), ctx.now) : r.content },
  );
  const earlier = older.length
    ? older
        .slice(-6)
        .map((r) => r.content.replace(/\s+/g, " ").slice(0, 60))
        .join(" | ")
        .slice(0, 400)
    : null;
  return { messages, earlier };
}

// ---------------------------------------------------------------------------
// Limits and usage
// ---------------------------------------------------------------------------

async function checkLimits(ctx: ServiceContext, cfg: AssistantConfig): Promise<string | null> {
  const day = today(ctx);
  const [{ n }] = (await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(assistantUsage)
    .where(and(eq(assistantUsage.userId, ctx.user.id), eq(assistantUsage.day, day)))) as [{ n: number }];
  if (n >= cfg.dailyLimit) return `Daily limit reached (${cfg.dailyLimit} AI requests per founder; AI_DAILY_LIMIT). It resets at midnight — quick commands like /tasks still work.`;
  const [{ m }] = (await ctx.db
    .select({ m: sql<number>`count(*)::int` })
    .from(assistantUsage)
    .where(and(eq(assistantUsage.userId, ctx.user.id), gt(assistantUsage.createdAt, new Date(ctx.now.getTime() - 60_000))))) as [{ m: number }];
  if (m >= cfg.perMinute) return "Too many AI requests in a minute — wait a moment and try again.";
  return null;
}

async function logUsage(ctx: ServiceContext, cfg: AssistantConfig, u: { input: number; cached: number; output: number }, error: string | null, steps: number) {
  await ctx.db.insert(assistantUsage).values({
    userId: ctx.user.id,
    day: today(ctx),
    model: cfg.model,
    inputTokens: u.input,
    cachedTokens: u.cached,
    outputTokens: u.output,
    error,
    createdAt: ctx.now,
  });
  // Counts only — never message content, never the key.
  console.info(JSON.stringify({ event: "assistant_usage", user: ctx.user.id, model: cfg.model, steps, input: u.input, cached: u.cached, output: u.output, error }));
}

export interface UsageSummary {
  configured: boolean;
  model: string;
  dailyLimit: number;
  today: { requests: number; input: number; cached: number; output: number };
  month: { requests: number; input: number; cached: number; output: number; costUsd: number };
  quotaProblem: boolean;
  price: AssistantConfig["price"];
}

/** Settings → AI assistant card: this founder's requests today, tokens, and the month's estimated cost (both founders). */
export async function usageSummary(ctx: ServiceContext, env?: Record<string, string | undefined>): Promise<UsageSummary> {
  assertFounder(ctx);
  const cfg = assistantConfig(env);
  const day = today(ctx);
  const sums = {
    requests: sql<number>`count(*)::int`,
    input: sql<number>`coalesce(sum(${assistantUsage.inputTokens}), 0)::int`,
    cached: sql<number>`coalesce(sum(${assistantUsage.cachedTokens}), 0)::int`,
    output: sql<number>`coalesce(sum(${assistantUsage.outputTokens}), 0)::int`,
  };
  const [t] = await ctx.db.select(sums).from(assistantUsage).where(and(eq(assistantUsage.userId, ctx.user.id), eq(assistantUsage.day, day)));
  const [m] = await ctx.db.select(sums).from(assistantUsage).where(gte(assistantUsage.day, `${day.slice(0, 7)}-01`));
  return {
    configured: !!cfg.apiKey,
    model: cfg.model,
    dailyLimit: cfg.dailyLimit,
    today: t!,
    month: { ...m!, costUsd: estimateCost(cfg, m!) },
    quotaProblem: await quotaProblem(ctx),
    price: cfg.price,
  };
}

// ---------------------------------------------------------------------------
// Sending a message
// ---------------------------------------------------------------------------

function lang(text: string): "en" | "ru" | "ky" {
  if (/[өүң]/i.test(text)) return "ky";
  if (/[а-яё]/i.test(text)) return "ru";
  return "en";
}

const CARD_LINE = {
  en: (n: number) => (n === 1 ? "Check the card and press the button to save it, or Cancel." : `Check the ${n} cards and press the buttons to save them.`),
  ru: (n: number) => (n === 1 ? "Проверьте карточку и нажмите кнопку, чтобы сохранить, или «Отмена»." : `Проверьте ${n} карточки и нажмите кнопки, чтобы сохранить.`),
  ky: (n: number) => (n === 1 ? "Карточканы текшериңиз жана сактоо үчүн баскычты басыңыз." : `${n} карточканы текшерип, баскычтарды басыңыз.`),
};

async function promptContext(ctx: ServiceContext, earlier: string | null): Promise<string> {
  const [companies, founders] = await Promise.all([listCompanies(ctx), listFounders(ctx)]);
  const d = today(ctx);
  return contextMessage({
    today: d,
    weekday: WEEKDAYS_EN[isoWeekday(d) - 1]!,
    founder: ctx.user.shortName,
    otherFounders: founders.filter((f) => f.id !== ctx.user.id).map((f) => f.shortName),
    companies: companies.map((c) => ({ name: c.name, slug: c.slug, kind: c.kind })),
    earlier,
  });
}

/** The first request of a turn (exported for the token-budget test). */
export async function buildRequest(ctx: ServiceContext, cfg: AssistantConfig, text: string, before?: Date): Promise<{ req: ChatRequest; toolNames: string[] }> {
  const hist = await historyForModel(ctx, before);
  const recentText = [...hist.messages.slice(-2).map((m) => ("content" in m && typeof m.content === "string" ? m.content : "")), text].join("\n");
  const toolNames = routeTools(recentText);
  const { chat } = assistantTools(toolNames);
  const req: ChatRequest = {
    model: cfg.model,
    messages: [{ role: "system", content: STATIC_PROMPT }, { role: "system", content: await promptContext(ctx, hist.earlier) }, ...hist.messages, { role: "user", content: text }],
    tools: chat,
    max_completion_tokens: cfg.maxOutputTokens,
    parallel_tool_calls: true,
    ...(cfg.reasoningEffort ? { reasoning_effort: cfg.reasoningEffort } : {}),
    ...(cfg.temperature !== null ? { temperature: cfg.temperature } : {}),
  };
  return { req, toolNames };
}

async function createAction(ctx: ServiceContext, tool: string, plan: unknown, preview: ActionPreview): Promise<{ action: AssistantAction; token: string }> {
  const token = randomBytes(24).toString("base64url");
  const [action] = await ctx.db
    .insert(assistantActions)
    .values({ userId: ctx.user.id, tool, plan: plan as object, preview, tokenHash: sha256(token), status: "pending", expiresAt: new Date(ctx.now.getTime() + ACTION_TTL_MS), createdAt: ctx.now })
    .returning();
  return { action: action!, token };
}

/**
 * Handles one founder message: a local command, or the model with tools (up to maxSteps calls).
 * Returns the new messages to append in the panel.
 */
export async function sendMessage(ctx: ServiceContext, rawText: string, deps: AssistantDeps): Promise<{ messages: ChatMessageView[]; notice: string | null }> {
  assertFounder(ctx);
  const text = rawText.trim().slice(0, MAX_INPUT_CHARS);
  if (!text) throw new ServiceError("validation", "Write a message");
  const cfg = assistantConfig(deps.env);
  const at = clock(ctx);

  const local = parseLocalCommand(text);
  if (local) {
    const q = await addMessage(ctx, at, "cmd", text);
    const a = await addMessage(ctx, at, "local", await runLocalCommand(ctx, local, deps.baseUrl));
    return { messages: await viewsOf(ctx, [q, a]), notice: null };
  }

  if (!cfg.apiKey) {
    // Nothing stored, nothing sent: the panel shows how to set it up.
    const now = ctx.now.toISOString();
    return {
      messages: [
        { id: `local-${ctx.now.getTime()}-q`, role: "user", text, createdAt: now },
        { id: `local-${ctx.now.getTime()}-a`, role: "error", text: NOT_SET_UP, createdAt: now },
      ],
      notice: NOT_SET_UP,
    };
  }

  const limited = await checkLimits(ctx, cfg);
  if (limited) {
    const q = await addMessage(ctx, at, "cmd", text);
    const e = await addMessage(ctx, at, "error", limited);
    return { messages: await viewsOf(ctx, [q, e]), notice: null };
  }

  const userRow = await addMessage(ctx, at, "user", text);
  const { req } = await buildRequest(ctx, cfg, text, userRow.createdAt);
  const env: ToolEnv = { ctx, baseUrl: deps.baseUrl };
  const usage = { input: 0, cached: 0, output: 0 };
  const created: { row: AssistantMessage; token: string }[] = [];
  let reply: string | null = null;
  let errorCode: string | null = null;
  let steps = 0;

  try {
    for (; steps < cfg.maxSteps; ) {
      steps++;
      const res = await chatCompletion(cfg, req, deps);
      usage.input += res.usage.input;
      usage.cached += res.usage.cached;
      usage.output += res.usage.output;
      const calls = res.message.tool_calls ?? [];
      if (!calls.length) {
        reply = res.message.content?.trim() || (res.finishReason === "length" ? "That answer got too long — ask a narrower question." : null);
        break;
      }
      req.messages.push({ role: "assistant", content: res.message.content ?? null, tool_calls: calls });
      let cardsThisStep = 0;
      for (const call of calls) {
        const tool = findTool(call.function.name, "assistant");
        let content: string;
        if (!tool) content = `Unknown tool ${call.function.name}.`;
        else {
          try {
            const raw = JSON.parse(call.function.arguments || "{}") as unknown;
            const args = z.object(tool.input).parse(raw);
            if (tool.kind === "read") {
              const out = await tool.run(env, args);
              content = compactResult(out.summary, out.data);
            } else {
              const { plan, preview } = await tool.prepare(env, args);
              const { action, token } = await createAction(ctx, tool.name, plan, preview);
              const row = await addMessage(ctx, at, "action", "", action.id);
              created.push({ row, token });
              cardsThisStep++;
              content = "Preview card shown to the founder. NOTHING is saved until they press its button.";
            }
          } catch (err) {
            content = err instanceof SyntaxError ? "Arguments were not valid JSON." : toolErrorMessage(err, "assistant");
          }
        }
        req.messages.push({ role: "tool", tool_call_id: call.id, content });
      }
      // A card is the answer: a fixed line in the founder's language instead of another model call.
      if (cardsThisStep > 0 && cardsThisStep === calls.length) {
        reply = CARD_LINE[lang(text)](created.length);
        break;
      }
    }
    if (reply === null) reply = created.length ? CARD_LINE[lang(text)](created.length) : "I couldn't finish that in a few steps — try a narrower question.";
  } catch (err) {
    if (!(err instanceof AssistantError)) {
      console.error("[assistant] unexpected error", err instanceof Error ? err.name : typeof err);
    }
    errorCode = err instanceof AssistantError ? err.code : "unexpected";
    reply = null;
  }

  await logUsage(ctx, cfg, usage, errorCode, steps);
  const rows: AssistantMessage[] = [userRow, ...created.map((c) => c.row)];
  if (errorCode) rows.push(await addMessage(ctx, at, "error", errorMessage(errorCode as never, cfg.model)));
  else rows.push(await addMessage(ctx, at, "assistant", reply!));
  const tokens = new Map<string, string>();
  for (const c of created) tokens.set(c.row.actionId!, c.token);
  return { messages: await viewsOf(ctx, rows, tokens), notice: errorCode === "insufficient_quota" ? QUOTA_MESSAGE : null };
}

// ---------------------------------------------------------------------------
// Confirm / cancel a card
// ---------------------------------------------------------------------------

function tokenMatches(hash: string, token: string): boolean {
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(sha256(token), "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The founder pressed a card's button. Runs the stored plan only when: the action belongs to this
 * founder, the token is the one issued with the card, it is still pending and not expired. The
 * status flips pending → running atomically, so a double click writes once.
 */
export async function decideAction(ctx: ServiceContext, actionId: string, token: string, decision: "confirm" | "cancel", deps: AssistantDeps): Promise<ActionView> {
  assertFounder(ctx);
  if (!/^[0-9a-f-]{36}$/i.test(actionId)) throw new ServiceError("not_found", "Card not found");
  const [a] = await ctx.db.select().from(assistantActions).where(and(eq(assistantActions.id, actionId), eq(assistantActions.userId, ctx.user.id)));
  if (!a || typeof token !== "string" || !tokenMatches(a.tokenHash, token)) throw new ServiceError("not_found", "Card not found");
  if (a.status !== "pending") throw new ServiceError("conflict", a.status === "done" ? "Already saved" : `This card is ${a.status}`);
  if (a.expiresAt.getTime() <= ctx.now.getTime()) {
    await ctx.db.update(assistantActions).set({ status: "expired", decidedAt: ctx.now }).where(eq(assistantActions.id, a.id));
    throw new ServiceError("conflict", "This card expired — ask again");
  }
  const next = decision === "confirm" ? "running" : "cancelled";
  const [claimed] = await ctx.db
    .update(assistantActions)
    .set({ status: next, decidedAt: ctx.now })
    .where(and(eq(assistantActions.id, a.id), eq(assistantActions.userId, ctx.user.id), eq(assistantActions.status, "pending"), eq(assistantActions.tokenHash, a.tokenHash)))
    .returning();
  if (!claimed) throw new ServiceError("conflict", "This card was already handled");
  if (decision === "cancel") return actionView(claimed, ctx.now);

  const tool = findTool(a.tool, "assistant");
  let status = "done";
  let result: string;
  if (!tool || tool.kind !== "write") {
    status = "failed";
    result = "This action is no longer available.";
  } else {
    try {
      const out = await tool.commit({ ctx, baseUrl: deps.baseUrl }, a.plan);
      result = out.summary;
    } catch (err) {
      status = "failed";
      result = `Not saved: ${toolErrorMessage(err, "assistant")}`;
    }
  }
  const [row] = await ctx.db.update(assistantActions).set({ status, result }).where(eq(assistantActions.id, a.id)).returning();
  return actionView(row!, ctx.now);
}

/** For tests and the REST layer: the stored rows in order. */
export async function chatRows(ctx: ServiceContext) {
  return ctx.db.select().from(assistantMessages).where(eq(assistantMessages.userId, ctx.user.id)).orderBy(asc(assistantMessages.createdAt));
}
