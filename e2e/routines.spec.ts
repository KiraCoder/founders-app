import { expect, test } from "@playwright/test";
import { E2E_WEBHOOK_SECRET, login } from "./helpers";

type Actions = { method: string; params: { text?: string; reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] } } }[];

test("routine for a linked person (dialog, checklist builder) → Run now → Russian message → tick edits it in place → re-ask shows only the rest → done → edit with the confirm", async ({
  page,
}) => {
  await login(page, "nuraaly");
  const people = (await (await page.request.get("/api/v1/people?q=Elmurat")).json()) as { data: { id: string; fullName: string }[] };
  const person = people.data.find((p) => p.fullName === "Elmurat")!;
  const hook = (data: object) =>
    page.request.post("/api/telegram/webhook", { headers: { "x-telegram-bot-api-secret-token": E2E_WEBHOOK_SECRET }, data });

  // Link Elmurat (invite → /start CODE in his private chat) and switch the bot on, no quiet hours for this run.
  await page.goto(`/people/${person.id}`);
  const card = page.getByTestId("person-telegram-card");
  await card.getByRole("button", { name: "Invite Elmurat to Telegram" }).click();
  const command = ((await card.getByTestId("invite-command").textContent()) ?? "").trim();
  const chat = 810_000_000 + Math.floor(Math.random() * 1_000_000);
  await hook({ update_id: chat, message: { message_id: 1, chat: { id: chat, type: "private" }, from: { id: chat, first_name: "Elmurat" }, text: command } });
  await page.goto("/settings/team-telegram");
  const member = page.getByTestId("team-member").filter({ hasText: "Elmurat" });
  if (await member.getByRole("button", { name: "Switch on" }).isVisible()) await member.getByRole("button", { name: "Switch on" }).click();
  await expect(member.getByText("Bot messages them")).toBeVisible();
  await member.getByText(/^Chase settings for Elmurat/).click();
  const chaseForm = member.getByRole("form", { name: "Chase settings for Elmurat" });
  await chaseForm.getByLabel("Quiet from").fill("00:00");
  await chaseForm.getByLabel("Quiet until").fill("00:00");
  await chaseForm.getByRole("button", { name: "Save for Elmurat" }).click();
  await expect(chaseForm.getByRole("status")).toHaveText("Saved");

  // Routines → + New (a dialog): a 2-item checklist on a day that is NOT today (so only "Run now" asks).
  const todayIso = new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: "Asia/Bishkek" }).format(new Date());
  const other = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].find((d) => d !== todayIso)!;
  const title = `[e2e] routine ${Date.now()}`;
  await page.goto("/routines");
  await page.getByRole("button", { name: "New routine" }).click();
  const dialog = page.getByRole("dialog", { name: "New routine" });
  const form = dialog.getByRole("form", { name: "Routine" });
  await form.getByLabel("Title").fill(title);
  await form.getByLabel("Who does it").selectOption(`person:${person.id}`);
  // The company list is limited to Elmurat's companies.
  await expect(form.getByLabel("Company").locator("option")).not.toHaveCount(0);
  await expect(form.getByText("Only the companies Elmurat works for.")).toBeVisible();
  for (const d of ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]) await form.getByRole("group", { name: "Days" }).getByLabel(d, { exact: true }).setChecked(d === other);
  await expect(form.getByRole("listitem").filter({ hasText: "10:00" })).toBeVisible();
  await form.getByLabel("Checklist", { exact: true }).check();
  for (const item of ["Kiwi Go", "Jobutify"]) {
    await form.getByLabel("New item").fill(item);
    await form.getByRole("button", { name: "+ Add item" }).click();
  }
  await expect(form.getByLabel("Item 2 title")).toHaveValue("Jobutify");
  await form.getByLabel("Ask once").check();
  await expect(form.getByTestId("routine-summary")).toContainText(`Bot asks Elmurat ${other} at 10:00, no reminders`);
  await form.getByRole("button", { name: "Create routine" }).click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await expect(page.getByRole("link", { name: "Back" })).toBeVisible();
  await page.getByRole("button", { name: "Run now" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Asked now: sent to Telegram" })).toBeVisible();

  // Staff tick → the Russian message in the dev inbox, one button per item.
  await page.goto("/dev/notifications");
  await page.getByRole("button", { name: "Simulate staff tick" }).click();
  const msg = page.getByTestId("team-message").filter({ hasText: `Рутина: ${title}` });
  await expect(msg).toBeVisible();
  await expect(msg.getByText("Прогресс: 0/2")).toBeVisible();
  await expect(msg.getByText("⬜ Kiwi Go")).toBeVisible();
  const kiwi = await msg.locator(".btn", { hasText: "✓ Kiwi Go" }).getAttribute("data-callback");
  await expect(msg.locator(".btn", { hasText: "✓ Jobutify" })).toBeVisible();
  await expect(msg.locator(".btn", { hasText: "💬 Комментарий" })).toBeVisible();
  expect(kiwi).toMatch(/^a:/);

  // Elmurat ticks Kiwi Go: the message is edited in place.
  const press = async (data: string, id: number) =>
    (await (
      await hook({
        update_id: id,
        callback_query: { id: "e2e", from: { id: chat }, data, message: { message_id: 7, chat: { id: chat, type: "private" }, text: `Рутина: ${title}` } },
      })
    ).json()) as { actions: Actions };
  const first = await press(kiwi!, chat + 10);
  expect(first.actions[0]!.params.text).toBe("✓ Kiwi Go. Осталось: 1");
  const edited = first.actions.find((a) => a.method === "editMessageText")!;
  expect(edited.params.text).toContain("✅ Kiwi Go");
  expect(edited.params.text).toContain("Прогресс: 1/2");

  // Re-ask (/routines): only Jobutify has a tick button.
  const again = (await (
    await hook({ update_id: chat + 11, message: { message_id: 2, chat: { id: chat, type: "private" }, from: { id: chat, first_name: "Elmurat" }, text: "/routines" } })
  ).json()) as { actions: Actions };
  const reask = again.actions.find((a) => a.params.text?.includes(title))!;
  expect(reask.params.text).toContain("⬜ Jobutify");
  const ticks = reask.params.reply_markup!.inline_keyboard.flat().filter((b) => b.text.startsWith("✓ "));
  expect(ticks.map((b) => b.text)).toEqual(["✓ Jobutify"]);
  const last = await press(ticks[0]!.callback_data, chat + 12);
  expect(last.actions[0]!.params.text).toBe("Рутина выполнена ✓ Спасибо!");
  expect(last.actions.find((a) => a.method === "editMessageText")!.params.text).toContain("Готово, спасибо! 2/2 ✅");

  // The routine's page shows today's run as done, with who ticked.
  await page.goto("/routines");
  const row = page.getByTestId("routine-row").filter({ hasText: title });
  await expect(row).toContainText("Today 2/2 · done");
  await row.getByRole("link", { name: "Open" }).click();
  await expect(page.getByTestId("routine-run").first()).toContainText(/Done (on time|late)/);
  await expect(page.getByTestId("routine-run").first()).toContainText("2/2 ticked");
  await expect(page.getByTestId("routine-run").first()).toContainText("by Elmurat");
  await expect(page.getByTestId("routine-message").first()).toBeVisible();

  // Edit (dialog): a new item while today's run is done → the confirm explains, "from the next run".
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const editForm = page.getByRole("dialog", { name: `Edit “${title}”` }).getByRole("form", { name: "Routine" });
  await editForm.getByLabel("New item").fill("Alura Brand");
  await editForm.getByRole("button", { name: "+ Add item" }).click();
  await editForm.getByRole("button", { name: "Save routine" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Today's run is already done" });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Save from the next run" }).click();
  await expect(page.getByRole("status").filter({ hasText: "applies from the next run" })).toBeVisible();
  await expect(page.getByText("Checklist, 3 items")).toBeVisible();
});
