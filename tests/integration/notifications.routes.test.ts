import { afterEach, describe, expect, it } from "vitest";
import { POST as webhook } from "@/app/api/telegram/webhook/route";
import { GET as cronGet, maxDuration as cronMaxDuration, POST as cron } from "@/app/api/cron/tick/route";

afterEach(() => {
  delete process.env.TELEGRAM_WEBHOOK_SECRET;
  delete process.env.CRON_SECRET;
});

const update = JSON.stringify({ update_id: 1, message: { message_id: 1, chat: { id: 1, type: "private" }, text: "/help" } });

describe("secret-protected routes (rejected before touching the database)", () => {
  it("webhook rejects a missing or wrong secret", async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = "right-secret-value";
    const cases: Record<string, string>[] = [{}, { "x-telegram-bot-api-secret-token": "wrong" }, { "x-telegram-bot-api-secret-token": "" }];
    for (const headers of cases) {
      const res = await webhook(new Request("http://x/api/telegram/webhook", { method: "POST", headers, body: update }));
      expect(res.status).toBe(401);
    }
  });

  it("webhook rejects everything when no secret is configured", async () => {
    const res = await webhook(
      new Request("http://x/api/telegram/webhook", {
        method: "POST",
        headers: { "x-telegram-bot-api-secret-token": "anything" },
        body: update,
      }),
    );
    expect(res.status).toBe(401);
  });

  it("cron tick needs CRON_SECRET", async () => {
    expect((await cron(new Request("http://x/api/cron/tick", { method: "POST" }))).status).toBe(401);
    process.env.CRON_SECRET = "cron-secret-value";
    expect(
      (await cron(new Request("http://x/api/cron/tick", { method: "POST", headers: { authorization: "Bearer nope" } }))).status,
    ).toBe(401);
    expect((await cronGet(new Request("http://x/api/cron/tick", { headers: { "x-cron-secret": "nope" } }))).status).toBe(401);
  });
});

describe("cron route duration (whole-app review #11)", () => {
  it("may run up to 60 s on Vercel (the README pg_cron snippet waits as long)", () => {
    expect(cronMaxDuration).toBe(60);
  });
});
