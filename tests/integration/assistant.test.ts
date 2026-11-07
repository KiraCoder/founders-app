import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { assistantActions, assistantMessages, assistantUsage, people, personCompanies, routines, salaries } from "@/server/db/schema";
import { toolsFor } from "@/server/mcp/all-tools";
import { COCKPIT_TOOLS } from "@/server/mcp/registry";
import { buildRequest, clearChat, decideAction, getChat, historyForModel, quotaProblem, sendMessage, usageSummary, type ChatMessageView } from "@/server/assistant/service";
import { assistantConfig, NOT_SET_UP } from "@/server/assistant/config";
import { STATIC_PROMPT, estimateTokens } from "@/server/assistant/prompt";
import { routeTools, MAX_TOOLS } from "@/server/assistant/router";
import { classify, QUOTA_MESSAGE } from "@/server/assistant/openai";
import { createTask } from "@/server/services/tasks";
import { createTestDb, FIXED_NOW, type TestDb } from "../helpers/db";

/** A fake OpenAI: queued replies, every request body recorded. No network, no real key. */
function fakeOpenAi(replies: (Response | Error | (() => Response))[]) {
  const bodies: Record<string, unknown>[] = [];
  const headers: Record<string, string>[] = [];
  const fn = async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    headers.push(Object.fromEntries(new Headers(init?.headers).entries()));
    const next = replies.shift();
    if (!next) throw new Error("no more fake replies");
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next() : next;
  };
  return { fetch: fn as unknown as typeof fetch, bodies, headers, calls: () => bodies.length };
}

const ok = (message: Record<string, unknown>, usage = { prompt_tokens: 1200, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 1024 } }) =>
  new Response(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }], usage }), { status: 200, headers: { "content-type": "application/json" } });
const text = (content: string) => ok({ role: "assistant", content });
const toolCall = (name: string, args: unknown, id = "call_1") => ok({ role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
const fail = (status: number, error: Record<string, unknown>) => new Response(JSON.stringify({ error }), { status, headers: { "content-type": "application/json" } });

const ENV = { OPENAI_API_KEY: "test-placeholder", OPENAI_MODEL: "gpt-5-mini" };
const noSleep = async () => {};

let t: TestDb;
let asanId: string;
const deps = (f: ReturnType<typeof fakeOpenAi>, env: Record<string, string | undefined> = ENV) => ({ env, fetch: f.fetch, sleep: noSleep, baseUrl: "" });

beforeAll(async () => {
  t = await createTestDb();
  const [asan] = await t.handle.db.insert(people).values({ fullName: "Asan Usupov" }).returning();
  asanId = asan!.id;
  const [link] = await t.handle.db.insert(personCompanies).values({ personId: asan!.id, companyId: t.companyIds["kiwi-go"]!, role: "cashier" }).returning();
  await t.handle.db.insert(salaries).values({ personCompanyId: link!.id, amount: "987654", effectiveFrom: "2026-01-01" });
});
afterAll(async () => {
  await t.handle.close();
});
beforeEach(async () => {
  await t.handle.db.delete(assistantMessages);
  await t.handle.db.delete(assistantActions);
  await t.handle.db.delete(assistantUsage);
});

const toolMessages = (body: Record<string, unknown>) => (body.messages as { role: string; content: string }[]).filter((m) => m.role === "tool").map((m) => m.content);

describe("one tool registry for MCP and the assistant", () => {
  it("the connector keeps its 10 tools; the assistant gets the same objects plus routine tools", () => {
    const mcp = toolsFor("mcp");
    expect(mcp.map((x) => x.name).sort()).toEqual(
      ["add_task_comment", "add_tasks", "complete_task", "create_project", "get_project", "list_companies", "list_people", "list_projects", "list_tasks", "update_task"].sort(),
    );
    const assistant = toolsFor("assistant");
    for (const tool of COCKPIT_TOOLS) expect(assistant).toContain(tool);
    expect(assistant.map((x) => x.name)).toEqual(expect.arrayContaining(["list_routines", "get_routine", "create_routine", "update_routine"]));
    expect(mcp.map((x) => x.name)).not.toContain("create_routine");
    // Every write tool is split into prepare (no writes) + commit.
    for (const tool of assistant.filter((x) => x.kind === "write")) expect(tool.kind === "write" && typeof tool.prepare === "function" && typeof tool.commit === "function").toBe(true);
  });
});

describe("no key", () => {
  it("panel says AI is not set up; nothing is sent or stored; quick commands still work", async () => {
    const f = fakeOpenAi([]);
    const ctx = t.ctx("nuraaly");
    const state = await getChat(ctx, { env: {} });
    expect(state).toMatchObject({ configured: false, notice: NOT_SET_UP });
    expect(NOT_SET_UP).toBe("AI not set up — add OPENAI_API_KEY in Vercel (see README).");
    const res = await sendMessage(ctx, "what's overdue?", deps(f, {}));
    expect(res.messages.at(-1)).toMatchObject({ role: "error", text: NOT_SET_UP });
    expect(f.calls()).toBe(0);
    expect(await t.handle.db.select().from(assistantMessages)).toHaveLength(0);
    const cmd = await sendMessage(ctx, "/overdue", deps(f, {}));
    expect(cmd.messages.map((m) => m.role)).toEqual(["cmd", "local"]);
    expect(f.calls()).toBe(0);
  });
});

describe("answers from app data (mocked OpenAI with tool calls)", () => {
  it("runs a read tool, feeds a compact result back, logs token usage without content", async () => {
    const ctx = t.ctx("nuraaly");
    await createTask(ctx, { title: "Close the October acts", dueDate: "2026-10-30", companyId: t.companyIds["kiwi-go"], assigneePersonId: t.personIds.elmurat, visibility: "shared" } as never);
    const f = fakeOpenAi([toolCall("list_tasks", { assignee: "elmurat", overdue: true }), text("Elmurat: 1 overdue — Close the October acts (30 Oct).")]);
    const res = await sendMessage(ctx, "whats overdu for elmurat?", deps(f));
    expect(res.messages.at(-1)).toMatchObject({ role: "assistant", text: expect.stringContaining("Elmurat") });
    expect(f.calls()).toBe(2);
    const first = f.bodies[0]!;
    expect((first.messages as { content: string }[])[0]!.content).toBe(STATIC_PROMPT);
    expect(first.model).toBe("gpt-5-mini");
    expect(first.reasoning_effort).toBe("minimal");
    expect(first.temperature).toBeUndefined();
    expect(first.max_completion_tokens).toBeLessThanOrEqual(800);
    expect(f.headers[0]!.authorization).toBe("Bearer test-placeholder");
    const tool = toolMessages(f.bodies[1]!)[0]!;
    expect(tool).not.toContain("url");
    expect(tool).not.toContain('"overdue":false');
    const usage = await t.handle.db.select().from(assistantUsage);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ inputTokens: 2400, cachedTokens: 2048, outputTokens: 80, error: null, model: "gpt-5-mini" });
    const summary = await usageSummary(ctx, ENV);
    expect(summary.today.requests).toBe(1);
    expect(summary.month.costUsd).toBeGreaterThan(0);
  });

  it("an ambiguous name goes back to the model as the candidates list (it asks one question)", async () => {
    const f = fakeOpenAi([toolCall("list_people", { company: "alura" }), text("Alura Brand or Alura Style?")]);
    await sendMessage(t.ctx("nuraaly"), "who works at alura", deps(f));
    expect(toolMessages(f.bodies[1]!)[0]).toMatch(/matches several companies.*Alura Brand.*Alura Style/);
  });
});

describe("confirm before write", () => {
  const routineArgs = { title: "1C entries", who: "асан", company: "kiwi", days: [1, 2, 3, 4, 5, 6], time: "15:00", checklist: ["Kiwi Go", "Upsell"] };

  async function propose(who: "nuraaly" | "talant" = "nuraaly") {
    const f = fakeOpenAi([toolCall("create_routine", routineArgs)]);
    const res = await sendMessage(t.ctx(who), "асан каждый день кроме вс в 15 00 вносит 1с, чеклист киви апсел", deps(f));
    return { f, res, card: res.messages.find((m) => m.role === "action")!.action! };
  }

  it("a write tool call only shows a card; nothing is written until the founder confirms with the card's token", async () => {
    const before = (await t.handle.db.select().from(routines)).length;
    const { f, res, card } = await propose();
    expect(f.calls()).toBe(1); // the card is the answer: no second model call
    expect(res.messages.at(-1)!.text).toMatch(/Проверьте карточку/);
    expect(card).toMatchObject({ title: "New routine", confirm: "Create", status: "pending" });
    const fields = Object.fromEntries(card.fields.map((x) => [x.label, x.value]));
    expect(fields).toMatchObject({ Who: "Asan Usupov", Company: "Kiwi Go", Days: "Mon–Sat", Time: "15:00" });
    expect(fields.Checklist).toContain("Upsell");
    expect(card.token).toBeTruthy();
    expect((await t.handle.db.select().from(routines)).length).toBe(before);

    // Wrong token, or the other founder with the right token: refused, nothing written.
    await expect(decideAction(t.ctx("nuraaly"), card.id, "forged", "confirm", { baseUrl: "" })).rejects.toMatchObject({ code: "not_found" });
    await expect(decideAction(t.ctx("talant"), card.id, card.token!, "confirm", { baseUrl: "" })).rejects.toMatchObject({ code: "not_found" });
    expect((await t.handle.db.select().from(routines)).length).toBe(before);

    const done = await decideAction(t.ctx("nuraaly"), card.id, card.token!, "confirm", { baseUrl: "" });
    expect(done.status).toBe("done");
    const rows = await t.handle.db.select().from(routines).where(eq(routines.assigneePersonId, asanId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: "1C entries", time: "15:00", days: [1, 2, 3, 4, 5, 6], confirmation: "checklist" });
    // A second click (replay) writes nothing more.
    await expect(decideAction(t.ctx("nuraaly"), card.id, card.token!, "confirm", { baseUrl: "" })).rejects.toMatchObject({ code: "conflict" });
    expect(await t.handle.db.select().from(routines).where(eq(routines.assigneePersonId, asanId))).toHaveLength(1);
    await t.handle.db.delete(routines).where(eq(routines.assigneePersonId, asanId));
  });

  it("cancel writes nothing; an expired card cannot be confirmed", async () => {
    const { card } = await propose();
    expect((await decideAction(t.ctx("nuraaly"), card.id, card.token!, "cancel", { baseUrl: "" })).status).toBe("cancelled");
    const second = await propose();
    const later = t.ctx("nuraaly", new Date(FIXED_NOW.getTime() + 31 * 60_000));
    await expect(decideAction(later, second.card.id, second.card.token!, "confirm", { baseUrl: "" })).rejects.toMatchObject({ code: "conflict" });
    expect(await t.handle.db.select().from(routines).where(eq(routines.assigneePersonId, asanId))).toHaveLength(0);
  });

  it("the model's next turn sees the card's outcome, not a claim it saved", async () => {
    const { card } = await propose();
    await decideAction(t.ctx("nuraaly"), card.id, card.token!, "confirm", { baseUrl: "" });
    const h = await historyForModel(t.ctx("nuraaly"));
    expect(h.messages.some((m) => typeof m.content === "string" && /\[card create_routine .* done: Created routine/.test(m.content))).toBe(true);
    await t.handle.db.delete(routines).where(eq(routines.assigneePersonId, asanId));
  });
});

describe("privacy", () => {
  it("never shows salaries, nor the other founder's private todos", async () => {
    await createTask(t.ctx("talant"), { title: "Talant secret todo", visibility: "private" } as never);
    const f = fakeOpenAi([
      ok({
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "a", type: "function", function: { name: "list_people", arguments: JSON.stringify({ company: "kiwi go" }) } },
          { id: "b", type: "function", function: { name: "list_tasks", arguments: JSON.stringify({ status: "any", limit: 200 }) } },
        ],
      }),
      text("ok"),
    ]);
    await sendMessage(t.ctx("nuraaly"), "people at kiwi and all tasks, and Asan's salary", deps(f));
    const results = toolMessages(f.bodies[1]!).join("\n");
    expect(results).toContain("Asan Usupov");
    expect(results).not.toMatch(/salar|987654/i);
    expect(results).not.toContain("Talant secret todo");
    expect(STATIC_PROMPT).toMatch(/never see salaries/);
    // No tool of the assistant reads salaries.
    expect(toolsFor("assistant").map((x) => x.name).join(" ")).not.toMatch(/salar/);
  });

  it("each founder has their own chat; staff are refused", async () => {
    await sendMessage(t.ctx("nuraaly"), "/help", deps(fakeOpenAi([])));
    expect((await getChat(t.ctx("talant"), { env: ENV })).messages).toHaveLength(0);
    expect((await getChat(t.ctx("nuraaly"), { env: ENV })).messages).toHaveLength(2);
    await clearChat(t.ctx("nuraaly"));
    expect((await getChat(t.ctx("nuraaly"), { env: ENV })).messages).toHaveLength(0);
    const staff = { ...t.ctx("nuraaly"), user: { ...t.founders.nuraaly, role: "staff" as const } };
    await expect(getChat(staff, { env: ENV })).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("OpenAI errors never break the app", () => {
  const cases: [string, Response[], RegExp, number][] = [
    ["out of credit", [fail(429, { code: "insufficient_quota", type: "insufficient_quota", message: "You exceeded your current quota" })], /out of credit — add money at platform\.openai\.com\/settings\/organization\/billing/, 1],
    ["rate limited twice", [fail(429, { code: "rate_limit_exceeded" }), fail(429, { code: "rate_limit_exceeded" })], /OpenAI is busy, try again in a minute/, 2],
    ["invalid key", [fail(401, { code: "invalid_api_key" })], /key in Vercel is invalid or revoked — replace OPENAI_API_KEY/, 1],
    ["project not allowed", [fail(403, { code: "unsupported_country_region_territory" })], /invalid or revoked/, 1],
    ["model missing", [fail(404, { code: "model_not_found" })], /Model gpt-5-mini isn't available on this OpenAI account — change OPENAI_MODEL/, 1],
    ["context too long", [fail(400, { code: "context_length_exceeded" })], /too long.*nothing was saved/, 1],
    ["server error", [fail(503, { message: "overloaded" })], /OpenAI had a problem.*nothing was saved/, 1],
  ];
  for (const [name, replies, message, calls] of cases) {
    it(name, async () => {
      const f = fakeOpenAi(replies);
      const res = await sendMessage(t.ctx("nuraaly"), "hello", deps(f));
      expect(res.messages.at(-1)).toMatchObject({ role: "error", text: expect.stringMatching(message) });
      expect(f.calls()).toBe(calls);
      // History kept: the founder's message and the error line are stored.
      const stored = await t.handle.db.select().from(assistantMessages);
      expect(stored.map((m) => m.role)).toEqual(["user", "error"]);
      expect(await t.handle.db.select().from(assistantActions)).toHaveLength(0);
    });
  }

  it("network failure and timeout", async () => {
    const net = await sendMessage(t.ctx("nuraaly"), "hi", deps(fakeOpenAi([new TypeError("fetch failed")])));
    expect(net.messages.at(-1)!.text).toMatch(/Couldn't reach OpenAI/);
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    const slow = await sendMessage(t.ctx("nuraaly"), "hi", deps(fakeOpenAi([abort])));
    expect(slow.messages.at(-1)!.text).toMatch(/took too long/);
  });

  it("a rate limit is retried once and then answers", async () => {
    const f = fakeOpenAi([fail(429, { code: "rate_limit_exceeded" }), text("Hi!")]);
    const res = await sendMessage(t.ctx("nuraaly"), "hi", deps(f));
    expect(res.messages.at(-1)).toMatchObject({ role: "assistant", text: "Hi!" });
    expect(f.calls()).toBe(2);
  });

  it("out of credit shows a banner in the panel and Settings, until a request succeeds", async () => {
    const res = await sendMessage(t.ctx("nuraaly"), "hi", deps(fakeOpenAi([fail(429, { type: "insufficient_quota", message: "You exceeded your current quota, please check your plan" })])));
    expect(res.notice).toBe(QUOTA_MESSAGE);
    expect((await getChat(t.ctx("talant"), { env: ENV })).notice).toBe(QUOTA_MESSAGE);
    expect((await usageSummary(t.ctx("talant"), ENV)).quotaProblem).toBe(true);
    await sendMessage(t.ctx("nuraaly"), "hi", deps(fakeOpenAi([text("ok")])));
    expect(await quotaProblem(t.ctx("nuraaly"))).toBe(false);
  });

  it("classifies billing_hard_limit as out of credit", () => {
    expect(classify(429, { error: { code: "billing_hard_limit_reached" } })).toBe("insufficient_quota");
    expect(classify(429, { error: { code: "rate_limit_exceeded" } })).toBe("rate_limited");
  });
});

describe("limits", () => {
  it("AI_DAILY_LIMIT requests per founder per day, then no API call", async () => {
    const env = { ...ENV, AI_DAILY_LIMIT: "1" };
    await sendMessage(t.ctx("nuraaly"), "hi", deps(fakeOpenAi([text("ok")]), env));
    const f = fakeOpenAi([text("never")]);
    const res = await sendMessage(t.ctx("nuraaly"), "hi again", deps(f, env));
    expect(res.messages.at(-1)!.text).toMatch(/Daily limit reached \(1/);
    expect(f.calls()).toBe(0);
    expect(assistantConfig({}).dailyLimit).toBe(200);
  });
});

describe("lean requests", () => {
  it("a typical message stays well under the token budget", async () => {
    const { req, toolNames } = await buildRequest(t.ctx("nuraaly"), assistantConfig(ENV), "Did Asan finish today's checklist?");
    const est = estimateTokens(JSON.stringify(req));
    console.info(`[budget] typical request ≈ ${est} input tokens, ${toolNames.length} tools; static prompt ≈ ${estimateTokens(STATIC_PROMPT)} tokens`);
    expect(est).toBeLessThan(4000);
    expect(estimateTokens(STATIC_PROMPT)).toBeLessThan(950);
    expect(toolNames.length).toBeLessThanOrEqual(MAX_TOOLS);
  });

  it("history: only the last 8 turns go to the model, older asks become one short line", async () => {
    const ctx = t.ctx("nuraaly");
    for (let i = 0; i < 12; i++) {
      await t.handle.db.insert(assistantMessages).values([
        { userId: ctx.user.id, role: "user", content: `question ${i}`, createdAt: new Date(FIXED_NOW.getTime() - (100 - i * 2) * 1000) },
        { userId: ctx.user.id, role: "assistant", content: `answer ${i}`, createdAt: new Date(FIXED_NOW.getTime() - (99 - i * 2) * 1000) },
      ]);
    }
    const h = await historyForModel(ctx);
    expect(h.messages.filter((m) => m.role === "user")).toHaveLength(8);
    expect(h.messages[0]).toMatchObject({ role: "user", content: "question 4" });
    expect(h.earlier).toContain("question 0");
    expect(h.earlier).not.toContain("answer");
  });

  it("routes only the relevant tools", () => {
    const r = routeTools("каждый день в 15:00 чеклист для Элмурата");
    expect(r).toEqual(expect.arrayContaining(["create_routine", "list_routines"]));
    expect(r).not.toContain("create_project");
    const tk = routeTools("mark the insurance task done");
    expect(tk).toEqual(expect.arrayContaining(["complete_task", "list_tasks"]));
    expect(tk).not.toContain("create_routine");
    const plain = routeTools("hi, how are things at kiwi?");
    expect(plain.every((n) => !/^(create|add|update|complete)/.test(n))).toBe(true);
    for (const x of [r, tk, plain, routeTools("project task routine checklist plan")]) expect(x.length).toBeLessThanOrEqual(MAX_TOOLS);
  });

  it("simple commands are answered locally, without the model", async () => {
    const f = fakeOpenAi([]);
    for (const cmd of ["/tasks", "overdue", "просрочено", "/routines", "/help"]) {
      const res = await sendMessage(t.ctx("nuraaly"), cmd, deps(f));
      expect(res.messages.map((m: ChatMessageView) => m.role)).toEqual(["cmd", "local"]);
    }
    expect(f.calls()).toBe(0);
    expect(await t.handle.db.select().from(assistantUsage)).toHaveLength(0);
  });
});
