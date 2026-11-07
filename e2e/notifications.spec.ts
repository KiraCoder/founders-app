import { expect, test } from "@playwright/test";
import { E2E_CRON_SECRET, E2E_WEBHOOK_SECRET, login } from "./helpers";

test("settings → link code → /start via webhook → tick → morning summary in the dev inbox", async ({ page }) => {
  await login(page, "nuraaly");
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();

  // Start from a clean state if an earlier run left Telegram linked.
  const unlink = page.getByRole("button", { name: "Unlink" });
  if (await unlink.isVisible()) {
    await unlink.click();
    await expect(page.getByText("Not linked")).toBeVisible();
  }

  await page.getByRole("button", { name: "Generate link code" }).click();
  const command = (await page.getByTestId("link-command").textContent())?.trim() ?? "";
  expect(command).toMatch(/^\/start [A-Z2-9]{4}-[A-Z2-9]{4}$/);

  const chatId = 900_000_000 + Math.floor(Math.random() * 1_000_000);
  const update = {
    update_id: chatId,
    message: {
      message_id: 1,
      chat: { id: chatId, type: "private" },
      from: { id: chatId, first_name: "Nuraaly", username: "nuraaly_e2e" },
      text: command,
    },
  };

  // Wrong secret: rejected, nothing linked.
  const bad = await page.request.post("/api/telegram/webhook", {
    headers: { "x-telegram-bot-api-secret-token": "wrong" },
    data: update,
  });
  expect(bad.status()).toBe(401);

  // Telegram delivering "/start CODE".
  const ok = await page.request.post("/api/telegram/webhook", {
    headers: { "x-telegram-bot-api-secret-token": E2E_WEBHOOK_SECRET },
    data: update,
  });
  expect(ok.status()).toBe(200);
  const body = (await ok.json()) as { actions?: { params: { text: string } }[] };
  expect(body.actions?.[0]?.params.text).toContain("Linked to Nuraaly");

  // The code works only once.
  const again = await page.request.post("/api/telegram/webhook", {
    headers: { "x-telegram-bot-api-secret-token": E2E_WEBHOOK_SECRET },
    data: { ...update, message: { ...update.message, chat: { id: chatId + 1, type: "private" }, from: { id: chatId + 1 } } },
  });
  expect(((await again.json()) as { actions: { params: { text: string } }[] }).actions[0]!.params.text).toContain(
    "Code not accepted",
  );

  await page.reload();
  await expect(page.getByText("Linked", { exact: true })).toBeVisible();
  await expect(page.getByText("@nuraaly_e2e")).toBeVisible();

  // Run a tick as if it were the morning summary time and look at the dev inbox.
  await page.goto("/dev/notifications");
  await expect(page.getByText("Telegram linked as @nuraaly_e2e", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Simulate morning" }).click();
  const summary = page.locator("li", { hasText: "Good morning, Nuraaly" }).first();
  await expect(summary).toBeVisible();
  await expect(summary.getByText("sent", { exact: true })).toBeVisible();
  // No bot token in e2e, so nothing left the server.
  await expect(summary.getByText("via dev")).toBeVisible();

  // The real cron endpoint: secret required, then runs plan + dispatch.
  expect((await page.request.post("/api/cron/tick")).status()).toBe(401);
  const tick = await page.request.post("/api/cron/tick", { headers: { authorization: `Bearer ${E2E_CRON_SECRET}` } });
  expect(tick.status()).toBe(200);
  expect(((await tick.json()) as { ok: boolean }).ok).toBe(true);
});
