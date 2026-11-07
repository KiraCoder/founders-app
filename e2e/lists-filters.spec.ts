import { expect, test } from "@playwright/test";
import { login } from "./helpers";

/**
 * Tasks + Routines lists: "My tasks" (old views redirect), the WMS-style filter bar (status tabs
 * with counts, quick filter chips, saved "My filters", search, Condition with company → people,
 * sort; all in the URL, Back works), one row design, and checklists editable after creation.
 */
const noSideScroll = async (page: import("@playwright/test").Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);

test("Tasks: My tasks, old views redirect, filter bar in the URL, saved filters, company → people", async ({ page }) => {
  const stamp = Date.now();
  const title = `[e2e] filters ${stamp}`;
  await login(page, "nuraaly");
  const companies = (await (await page.request.get("/api/v1/companies")).json()) as { data: { id: string; slug: string }[] };
  const jobutify = companies.data.find((c) => c.slug === "jobutify")!.id;
  const people = (await (await page.request.get("/api/v1/people")).json()) as { data: { id: string; fullName: string }[] };
  const edil = people.data.find((p) => p.fullName === "Edil")!.id;
  const created = await page.request.post("/api/v1/tasks", {
    data: { title, visibility: "shared", companyId: jobutify, assigneePersonId: edil, dueDate: "2099-01-01" },
  });
  expect(created.status()).toBe(201);
  const personal = `[e2e] personal ${stamp}`;
  expect((await page.request.post("/api/v1/tasks", { data: { title: personal, visibility: "private" } })).status()).toBe(201);

  // Old views redirect: My todos → My tasks + "Personal"; Assigned to me → the "Assigned to me" chip.
  await page.goto("/tasks?view=my");
  await expect(page).toHaveURL(/\/tasks\?quick=personal$/); // "My tasks" is the default view
  await expect(page.getByRole("link", { name: "My tasks" })).toHaveAttribute("aria-current", "page");
  const quick = page.getByRole("group", { name: "Quick filters" });
  await expect(quick.getByRole("button", { name: "Personal" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("li[data-task-id]", { hasText: personal })).toBeVisible();
  await expect(page.locator("li[data-task-id]", { hasText: title })).toHaveCount(0);
  await page.goto("/tasks?view=assigned");
  await expect(page).toHaveURL(/quick=assigned/);

  // Company tasks: search, a quick filter, the status tabs (with counts).
  await page.goto("/tasks?view=company");
  const bar = page.getByRole("search", { name: "Filter tasks" });
  await expect(bar.getByRole("link", { name: /^Open · \d+$/ })).toHaveAttribute("aria-current", "page");
  await bar.getByRole("searchbox", { name: "Search" }).fill(title);
  await bar.getByRole("searchbox", { name: "Search" }).press("Enter");
  await expect(page).toHaveURL(/search=/);
  const row = page.locator("li[data-task-id]", { hasText: title });
  await expect(row).toBeVisible();
  await expect(page.locator("li[data-task-id]")).toHaveCount(1);
  await bar.getByRole("group", { name: "Quick filters" }).getByRole("button", { name: "Waiting on person" }).click();
  await expect(page).toHaveURL(/quick=waiting/);
  await expect(row).toBeVisible();
  await bar.getByRole("link", { name: /^Done · 0$/ }).click();
  await expect(page).toHaveURL(/status=done/);
  await expect(row).toHaveCount(0);
  await page.goBack();
  await expect(page).not.toHaveURL(/status=done/);
  await expect(row).toBeVisible();

  // Condition: a company limits the person list to its people (Upsell Group has no staff).
  await bar.getByRole("button", { name: "Condition" }).click();
  const cond = page.getByRole("form", { name: "Condition" });
  await cond.getByLabel("Company").selectOption({ label: "Upsell Group" });
  await expect(cond.getByLabel("Person").locator("option", { hasText: "Edil" })).toHaveCount(0);
  await expect(cond.getByLabel("Person").locator("option", { hasText: "Elmurat" })).toHaveCount(0);
  await cond.getByLabel("Company").selectOption({ label: "Jobutify" });
  await expect(cond.getByLabel("Person").locator("option", { hasText: "Edil" })).toHaveCount(1);
  await cond.getByLabel("Person").selectOption({ label: "Edil" });
  await cond.getByRole("button", { name: "Apply" }).click();
  await expect(page).toHaveURL(new RegExp(`company=${jobutify}.*who=person%3A${edil}|who=person%3A${edil}.*company=${jobutify}`));
  await expect(bar.getByRole("button", { name: "Condition · 2" })).toBeVisible();
  await expect(row).toBeVisible();

  // Sort is in the URL too.
  await bar.getByLabel("Sort").selectOption({ label: "Title" });
  await expect(page).toHaveURL(/sort=title/);

  // My filters: save the current filters as a chip, clear everything, come back through the chip, remove it.
  const filtered = page.url();
  const mine = bar.getByRole("group", { name: "My filters" });
  await mine.getByRole("button", { name: "+ Save current" }).click();
  await mine.getByLabel("Name of the saved filter").fill("Edil waiting");
  await mine.getByRole("button", { name: "Save" }).click();
  await expect(mine.getByRole("link", { name: "Edil waiting" })).toBeVisible();
  await bar.getByRole("link", { name: "Clear all" }).click();
  await expect(page).toHaveURL(/\/tasks\?view=company$/);
  await page.reload();
  await mine.getByRole("link", { name: "Edil waiting" }).click();
  for (const part of new URL(filtered).searchParams.keys()) await expect(page).toHaveURL(new RegExp(`[?&]${part}=`));
  await expect(row).toBeVisible();
  await mine.getByRole("button", { name: "Remove saved filter Edil waiting" }).click();
  await expect(mine.getByRole("link", { name: "Edil waiting" })).toHaveCount(0);

  // One row design: the routine icon set (comments + open links), on a phone the chips scroll inside their row.
  await expect(row.getByRole("link", { name: "Comments (0)" })).toBeVisible();
  await expect(row.getByRole("link", { name: "Open", exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await noSideScroll(page);
  await page.setViewportSize({ width: 1280, height: 800 });

  // Clean up.
  const all = (await (await page.request.get("/api/v1/tasks?view=mine&status=any&limit=500")).json()) as { data: { id: string; title: string }[] };
  for (const t of all.data.filter((x) => x.title.includes(String(stamp)))) await page.request.delete(`/api/v1/tasks/${t.id}`);
  const company = (await (await page.request.get("/api/v1/tasks?view=company&status=any&limit=500")).json()) as { data: { id: string; title: string }[] };
  for (const t of company.data.filter((x) => x.title.includes(String(stamp)))) await page.request.delete(`/api/v1/tasks/${t.id}`);
});

test("Routines: status tabs with counts, quick filters, search, company → people", async ({ page }) => {
  await login(page, "nuraaly");
  await page.goto("/routines");
  const bar = page.getByRole("search", { name: "Filter routines" });
  const active = bar.getByRole("link", { name: /^Active · \d+$/ });
  await expect(active).toHaveAttribute("aria-current", "page");
  const n = Number((await active.textContent())!.match(/\d+/)![0]);
  await expect(page.getByTestId("routine-row")).toHaveCount(n);
  await expect(bar.getByRole("link", { name: /^All · \d+$/ })).toBeVisible();

  const first = page.getByTestId("routine-row").first();
  const title = (await first.getByRole("link").first().textContent())!.trim();
  await bar.getByRole("searchbox", { name: "Search" }).fill(title.slice(0, 8));
  await bar.getByRole("searchbox", { name: "Search" }).press("Enter");
  await expect(page).toHaveURL(/search=/);
  await expect(page.getByTestId("routine-row").filter({ hasText: title })).toBeVisible();

  await bar.getByRole("group", { name: "Quick filters" }).getByRole("button", { name: "Has comments" }).click();
  await expect(page).toHaveURL(/quick=comments/);
  await bar.getByRole("group", { name: "Quick filters" }).getByRole("button", { name: "Has comments" }).click();
  await expect(page).not.toHaveURL(/quick=/);

  // Upsell Group: only its people (no staff there: the founders only).
  await bar.getByRole("button", { name: "Condition" }).click();
  const cond = page.getByRole("form", { name: "Condition" });
  await cond.getByLabel("Company").selectOption({ label: "Upsell Group" });
  const options = await cond.getByLabel("Person").locator("option").allTextContents();
  expect(options.filter((o) => o !== "Everyone").every((o) => o.endsWith("(founder)"))).toBe(true);
  await cond.getByLabel("Company").selectOption({ label: "Kiwi Go" });
  await expect(cond.getByLabel("Person").locator("option", { hasText: "Elmurat" })).toHaveCount(1);
  await expect(cond.getByLabel("Person").locator("option", { hasText: "Edil" })).toHaveCount(0);
  await cond.getByRole("button", { name: "Apply" }).click();
  await expect(page).toHaveURL(/company=/);

  await page.setViewportSize({ width: 390, height: 844 });
  await noSideScroll(page);
  await page.setViewportSize({ width: 1280, height: 800 });
});

test("Checklists after creation: task edit dialog + task page (reorder), routine page (edit, save)", async ({ page }) => {
  const title = `[e2e] checklist edit ${Date.now()}`;
  await login(page, "nuraaly");
  await page.goto("/tasks");
  await page.getByRole("button", { name: "New task" }).click();
  const form = page.getByRole("dialog", { name: "New task" }).getByRole("form", { name: "New task" });
  await form.getByLabel("Title").fill(title);
  await form.getByRole("button", { name: "Add task" }).click();
  const row = page.locator("li[data-task-id]", { hasText: title });
  await expect(row).toBeVisible();

  // The edit dialog has the checklist: add two items, move the second up.
  await row.getByRole("button", { name: "Edit", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Edit task" });
  const list = dialog.getByTestId("task-checklist");
  for (const item of ["Первый", "Второй"]) {
    await list.getByLabel("Item", { exact: true }).fill(item);
    await list.getByRole("button", { name: "+ Add item" }).click();
    await expect(list.getByTestId("checklist-item").filter({ hasText: item })).toBeVisible();
  }
  await list.getByRole("button", { name: "Move “Второй” up" }).click();
  await expect(list.getByTestId("checklist-item").first()).toContainText("Второй");
  await dialog.getByRole("button", { name: "Close" }).first().click();
  await expect(row.getByLabel("Checklist 0 of 2 done")).toBeVisible();

  // The task page: the same order; move it back down.
  await row.getByRole("link", { name: "Open", exact: true }).click();
  const pageList = page.getByTestId("task-checklist");
  await expect(pageList.getByTestId("checklist-item").first()).toContainText("Второй");
  await pageList.getByRole("button", { name: "Move “Второй” down" }).click();
  await expect(pageList.getByTestId("checklist-item").first()).toContainText("Первый");
  await expect(page.getByRole("list", { name: "Timeline" }).getByText(/Checklist: moved/).first()).toBeVisible();
  const id = page.url().split("/").pop()!;
  expect((await page.request.delete(`/api/v1/tasks/${id}`)).ok()).toBeTruthy();

  // Routine page: the checklist card edits the items in place.
  await page.goto("/routines?status=all");
  await page.getByTestId("routine-row").filter({ hasText: "1C" }).first().getByRole("link").first().click();
  const card = page.locator("section", { has: page.getByRole("heading", { name: /^Checklist/ }) });
  await card.getByRole("button", { name: /Edit checklist|Add a checklist/ }).click();
  const editor = card.getByRole("form", { name: "Edit checklist" });
  const extra = `E2E ${Date.now().toString(36)}`;
  await editor.getByLabel("New item").fill(extra);
  await editor.getByLabel("New item").press("Enter");
  await editor.getByRole("button", { name: "Save checklist" }).click();
  const confirm = page.getByRole("alertdialog");
  if (await confirm.isVisible().catch(() => false)) await confirm.getByRole("button").last().click();
  await expect(card.getByRole("list", { name: "Checklist" })).toContainText(extra);
  // Remove it again (the e2e database is reused between runs).
  await card.getByRole("button", { name: "Edit checklist" }).click();
  const items = card.getByRole("form", { name: "Edit checklist" }).getByRole("list", { name: "Checklist items" }).getByRole("listitem");
  const count = await items.count();
  await card.getByRole("form", { name: "Edit checklist" }).getByRole("button", { name: `Delete item ${count}` }).click();
  await card.getByRole("button", { name: "Save checklist" }).click();
  if (await page.getByRole("alertdialog").isVisible().catch(() => false)) await page.getByRole("alertdialog").getByRole("button").last().click();
  await expect(card.getByRole("list", { name: "Checklist" })).not.toContainText(extra);
});
