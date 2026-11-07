import { expect, test } from "@playwright/test";
import { E2E_WEBHOOK_SECRET, login } from "./helpers";

test("invite a person → /start via webhook → assign a task → tick → Russian message → Готово → done + founder line", async ({ page }) => {
  await login(page, "nuraaly");
  const people = (await (await page.request.get("/api/v1/people?q=Edil")).json()) as { data: { id: string; fullName: string }[] };
  const edil = people.data.find((p) => p.fullName === "Edil")!;
  const companies = (await (await page.request.get("/api/v1/companies")).json()) as { data: { id: string; slug: string }[] };
  const jobutify = companies.data.find((c) => c.slug === "jobutify")!;

  // Person page → Invite to Telegram: one-time code + deep link.
  await page.goto(`/people/${edil.id}`);
  const card = page.getByTestId("person-telegram-card");
  await card.getByRole("button", { name: "Invite Edil to Telegram" }).click();
  await expect(card.getByTestId("invite-link")).toContainText("https://t.me/");
  const command = ((await card.getByTestId("invite-command").textContent()) ?? "").trim();
  expect(command).toMatch(/^\/start [A-Z2-9]{4}-[A-Z2-9]{4}$/);

  // Edil opens the link: Telegram delivers "/start CODE" in his private chat.
  const chatId = 800_000_000 + Math.floor(Math.random() * 1_000_000);
  const started = await page.request.post("/api/telegram/webhook", {
    headers: { "x-telegram-bot-api-secret-token": E2E_WEBHOOK_SECRET },
    data: {
      update_id: chatId,
      message: { message_id: 1, chat: { id: chatId, type: "private" }, from: { id: chatId, first_name: "Edil" }, text: command },
    },
  });
  const startBody = (await started.json()) as { actions: { params: { text: string } }[] };
  expect(startBody.actions[0]!.params.text).toContain("Здравствуйте, Edil");

  // Settings → Team on Telegram: switch the bot on, no quiet hours for this run (any time of day).
  await page.goto("/settings/team-telegram");
  const member = page.getByTestId("team-member").filter({ hasText: "Edil" });
  await expect(member.getByText("Linked", { exact: true })).toBeVisible();
  if (await member.getByRole("button", { name: "Switch on" }).isVisible()) {
    await member.getByRole("button", { name: "Switch on" }).click();
  }
  await expect(member.getByText("Bot messages them")).toBeVisible();
  await member.getByText(/^Chase settings for Edil/).click();
  const chaseForm = member.getByRole("form", { name: "Chase settings for Edil" });
  await chaseForm.getByLabel("Quiet from").fill("00:00");
  await chaseForm.getByLabel("Quiet until").fill("00:00");
  await chaseForm.getByRole("button", { name: "Save for Edil" }).click();
  await expect(chaseForm.getByRole("status")).toHaveText("Saved");

  // Assign a task to Edil.
  const title = `[e2e] staff task ${Date.now()}`;
  const created = await page.request.post("/api/v1/tasks", {
    data: { title, companyId: jobutify.id, assigneePersonId: edil.id, visibility: "shared", dueDate: "2027-01-15" },
  });
  expect(created.status()).toBe(201);
  const taskId = ((await created.json()) as { data: { id: string } }).data.id;

  // Tick → the Russian message for Edil appears in the dev inbox's team messages.
  await page.goto("/dev/notifications");
  await page.getByRole("button", { name: "Simulate staff tick" }).click();
  const msg = page.getByTestId("team-message").filter({ hasText: `Новая задача: ${title}` });
  await expect(msg).toBeVisible();
  await expect(msg.getByText("Срок: 15.01 · Компания: Jobutify")).toBeVisible();
  await expect(msg.getByText("To Edil")).toBeVisible();
  const done = msg.locator(".btn", { hasText: "Готово" });
  const callback = (await done.getAttribute("data-callback"))!;
  expect(callback).toMatch(/^a:/);

  // Edil presses "Готово".
  const pressed = await page.request.post("/api/telegram/webhook", {
    headers: { "x-telegram-bot-api-secret-token": E2E_WEBHOOK_SECRET },
    data: {
      update_id: chatId + 1,
      callback_query: {
        id: "e2e",
        from: { id: chatId },
        data: callback,
        message: { message_id: 5, chat: { id: chatId, type: "private" }, text: `Новая задача: ${title}` },
      },
    },
  });
  const pressBody = (await pressed.json()) as { actions: { params: { text: string } }[] };
  expect(pressBody.actions[0]!.params.text).toContain("Отмечено как выполненное");

  const task = (await (await page.request.get(`/api/v1/tasks/${taskId}`)).json()) as { data: { status: string } };
  expect(task.data.status).toBe("done");

  // The founder gets one line (for the next summary), and the task page shows the trail.
  await page.reload();
  await expect(page.getByText(`Edil marked done (Telegram): ${title}`)).toBeVisible();
  await page.goto(`/tasks/${taskId}`);
  const trail = page.getByRole("list", { name: "Delivery trail" });
  await expect(trail.getByText("New task sent")).toBeVisible();
  await expect(trail.getByText("Marked done")).toBeVisible();

  // Founders comment on the task page (CRUD on their own comments).
  await page.getByLabel("New comment").fill("Thanks, Edil");
  await page.getByRole("button", { name: "Add comment" }).click();
  await expect(page.getByTestId("task-comment").filter({ hasText: "Thanks, Edil" })).toBeVisible();
});
