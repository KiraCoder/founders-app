/**
 * Settings → "Connect Telegram": setWebhook (our URL + secret, message/callback_query only),
 * setMyCommands (/today, /tasks, /help), getWebhookInfo status. Founders only. Fetch is
 * mocked: nothing talks to Telegram.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { resolveAppBaseUrl } from "@/server/app-url";
import { connectTelegram, telegramSetupConfig, telegramWebhookStatus } from "@/server/notifications/telegram-setup";
import { TelegramApi } from "@/server/notifications/telegram-api";
import { connectTelegramBot, getTelegramBotStatus, getTelegramSetupConfig } from "@/server/services/app-setup";
import { appUrl } from "@/server/services/ai-roles";
import { createTestDb, type TestDb } from "../helpers/db";

const TOKEN = "123456:TEST-token-not-real";
const SECRET = "test_webhook-secret_0123456789";
const ENV = { APP_URL: "https://cockpit.example.com/", TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_WEBHOOK_SECRET: SECRET };

interface Call {
  method: string;
  body: Record<string, unknown>;
  timeout: boolean;
}

function mockTelegram(answers: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const method = url.split("/").pop()!;
    expect(url.startsWith(`https://api.telegram.org/bot${TOKEN}/`)).toBe(true);
    calls.push({ method, body: JSON.parse(String(init.body)), timeout: init.signal instanceof AbortSignal });
    const answer =
      answers[method] ??
      (method === "getWebhookInfo"
        ? { ok: true, result: { url: "https://cockpit.example.com/api/telegram/webhook", pending_update_count: 2, last_error_date: 1793664000, last_error_message: "Wrong response from the webhook: 503 Service Unavailable" } }
        : { ok: true, result: true });
    return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } });
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("app URL", () => {
  it("APP_URL wins; else Vercel's production address, else the deployment URL (https added)", () => {
    expect(resolveAppBaseUrl({ APP_URL: "https://a.example.com//", VERCEL_URL: "x.vercel.app" })).toEqual({ url: "https://a.example.com", source: "APP_URL" });
    expect(resolveAppBaseUrl({ VERCEL_PROJECT_PRODUCTION_URL: "founders.vercel.app", VERCEL_URL: "founders-abc123.vercel.app" })).toEqual({
      url: "https://founders.vercel.app",
      source: "VERCEL_PROJECT_PRODUCTION_URL",
    });
    expect(resolveAppBaseUrl({ VERCEL_URL: "founders-abc123.vercel.app" })).toEqual({ url: "https://founders-abc123.vercel.app", source: "VERCEL_URL" });
    expect(resolveAppBaseUrl({ APP_URL: "  " })).toBeNull();
  });

  it("links in messages use the Vercel address when APP_URL is not set", () => {
    vi.stubEnv("APP_URL", "");
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "founders.vercel.app");
    expect(appUrl("/ai-roles")).toBe("https://founders.vercel.app/ai-roles");
  });
});

describe("telegramSetupConfig", () => {
  it("names exactly what is missing", () => {
    expect(telegramSetupConfig({}).missing).toEqual(["APP_URL", "TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET"]);
    expect(telegramSetupConfig({ VERCEL_URL: "x.vercel.app", TELEGRAM_BOT_TOKEN: TOKEN }).missing).toEqual(["TELEGRAM_WEBHOOK_SECRET"]);
    const ok = telegramSetupConfig(ENV);
    expect(ok).toEqual({
      missing: [],
      problems: [],
      appUrl: "https://cockpit.example.com",
      appUrlSource: "APP_URL",
      webhookUrl: "https://cockpit.example.com/api/telegram/webhook",
    });
  });

  it("flags a secret Telegram would refuse and a non-https address", () => {
    expect(telegramSetupConfig({ ...ENV, TELEGRAM_WEBHOOK_SECRET: "has spaces!" }).problems).toHaveLength(1);
    expect(telegramSetupConfig({ ...ENV, APP_URL: "http://localhost:3000" }).problems[0]).toMatch(/https/);
  });
});

describe("connectTelegram", () => {
  it("sets the webhook with the secret and allowed updates, sets /today /tasks /help, returns the status", async () => {
    const calls = mockTelegram();
    const r = await connectTelegram(ENV);
    expect(calls.map((c) => c.method)).toEqual(["setWebhook", "setMyCommands", "getWebhookInfo"]);
    expect(calls.every((c) => c.timeout)).toBe(true);
    expect(calls[0]!.body).toEqual({
      url: "https://cockpit.example.com/api/telegram/webhook",
      secret_token: SECRET,
      allowed_updates: ["message", "callback_query"],
    });
    expect((calls[1]!.body.commands as { command: string }[]).map((c) => c.command)).toEqual(["today", "tasks", "help"]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.status).toEqual({
      url: "https://cockpit.example.com/api/telegram/webhook",
      matchesThisApp: true,
      pendingUpdateCount: 2,
      lastErrorMessage: "Wrong response from the webhook: 503 Service Unavailable",
      lastErrorAt: new Date(1793664000 * 1000).toISOString(),
    });
    // The token and the secret never come back to the browser.
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it("calls nothing and names the missing variables when the config is incomplete", async () => {
    const calls = mockTelegram();
    const r = await connectTelegram({ TELEGRAM_BOT_TOKEN: TOKEN });
    expect(calls).toHaveLength(0);
    expect(r).toMatchObject({ ok: false, step: "config" });
    expect(r.message).toContain("APP_URL, TELEGRAM_WEBHOOK_SECRET");
  });

  it("uses Vercel's production address when APP_URL is not set", async () => {
    const calls = mockTelegram();
    await connectTelegram({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_WEBHOOK_SECRET: SECRET, VERCEL_PROJECT_PRODUCTION_URL: "founders.vercel.app" });
    expect(calls[0]!.body.url).toBe("https://founders.vercel.app/api/telegram/webhook");
  });

  it("reports a refused webhook (bad token) and stops", async () => {
    const calls = mockTelegram({ setWebhook: { ok: false, error_code: 401, description: "Unauthorized" } });
    const r = await connectTelegram(ENV);
    expect(calls.map((c) => c.method)).toEqual(["setWebhook"]);
    expect(r).toMatchObject({ ok: false, step: "setWebhook" });
    expect(r.message).toContain("Unauthorized");
    expect(r.message).toContain("TELEGRAM_BOT_TOKEN");
  });

  it("a network failure or timeout is a message, not a crash", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("The operation was aborted due to timeout");
    });
    const r = await connectTelegram(ENV, new TelegramApi(TOKEN));
    expect(r).toMatchObject({ ok: false, step: "setWebhook" });
    expect(r.message).toContain("timeout");
  });

  it("Check status: says when the bot delivers somewhere else", async () => {
    mockTelegram({ getWebhookInfo: { ok: true, result: { url: "https://old.example.com/hook", pending_update_count: 0 } } });
    const r = await telegramWebhookStatus(ENV);
    expect(r).toMatchObject({ ok: true, status: { url: "https://old.example.com/hook", matchesThisApp: false, lastErrorMessage: null } });
    expect(r.message).toMatch(/somewhere else/);
  });
});

describe("founders only", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(async () => {
    await t.handle.close();
  });

  it("refuses a staff user; a founder gets the result", async () => {
    vi.stubEnv("APP_URL", ENV.APP_URL);
    vi.stubEnv("TELEGRAM_BOT_TOKEN", TOKEN);
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
    const calls = mockTelegram();
    const staff = { ...t.ctx("talant"), user: { ...t.founders.talant, role: "staff" as const } };
    expect(() => getTelegramSetupConfig(staff)).toThrow(/Only the founders/);
    await expect(connectTelegramBot(staff)).rejects.toMatchObject({ code: "forbidden" });
    await expect(getTelegramBotStatus(staff)).rejects.toMatchObject({ code: "forbidden" });
    expect(calls).toHaveLength(0);
    expect((await connectTelegramBot(t.ctx("talant"))).ok).toBe(true);
  });
});
