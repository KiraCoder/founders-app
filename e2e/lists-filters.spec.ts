import { expect, test } from "@playwright/test";
import { login } from "./helpers";

/**
 * Tasks + Routines lists (0034, Linear style): view chips with counts, person chips, Filter pills,
 * Display, saved "My filters", search, company → people; all in the URL (Back works); old links
 * still work; and checklists (sub-tasks) editable after creation.
 */
const noSideScroll = async (page: import("@playwright/test").Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);


test("Tasks: view chips with counts, person chips, Filter pills, Display, saved filters, all in the URL; old views still work", async ({ page }) => {
  const stamp = Date.now();
  const title = `[e2e] filters ${stamp}`;
  await login(page, "nuraaly");
  const companies = (await (await page.request.get("/api/v1/companies")).json()) as { data: { id: string; slug: string }[] };
  const jobutify = companies.data.find((c) => c.slug === "jobutify")!.id;
  const people = (await (await page.request.get("/api/v1/people")).json()) as { data: { id: string; fullName: string }[] };
  const edil = people.data.find((p) => p.fullName === "Edil")!.id;
  const created = await page.request.post("/api/v1/tasks", {
    data: { title, visibility: "shared", companyId: jobutify, assigneePersonId: edil, dueDate: "2099-01-01", priority: "high" },
  });
  expect(created.status()).toBe(201);
  const personal = `[e2e] personal ${stamp}`;
  expect((await page.request.post("/api/v1/tasks", { data: { title: personal, visibility: "private" } })).status()).toBe(201);

  // Old views: "My todos" / "Assigned to me" are the "Me" person chip now.
  await page.goto("/tasks?view=my");
  const bar = page.getByRole("search", { name: "Filter tasks" });
  await expect(bar.getByRole("group", { name: "People" }).getByRole("link", { name: /\(me\)/ })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("li[data-task-id]", { hasText: personal })).toBeVisible();
  await expect(page.locator("li[data-task-id]", { hasText: title })).toHaveCount(0);

  // Active is the default view; grouped by status with counts.
  await page.goto("/tasks");
  await expect(bar.getByRole("navigation", { name: "Views" }).getByRole("link", { name: /^Active \d+$/ })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("region", { name: /^Todo \(\d+\)$/ })).toBeVisible();

  // Search (also by key) and a person chip (Edil: only his tasks).
  await bar.getByRole("searchbox", { name: "Search" }).fill(title);
  await bar.getByRole("searchbox", { name: "Search" }).press("Enter");
  await expect(page).toHaveURL(/search=/);
  const row = page.locator("li[data-task-id]", { hasText: title });
  await expect(row).toBeVisible();
  await expect(page.locator("li[data-task-id]")).toHaveCount(1);
  const key = (await row.getByTestId("task-key").textContent())!.trim();
  expect(key).toMatch(/^[A-Z][A-Z0-9]+-\d+$/);
  await bar.getByRole("searchbox", { name: "Search" }).fill(key.toLowerCase());
  await bar.getByRole("searchbox", { name: "Search" }).press("Enter");
  await expect(page.locator("li[data-task-id]")).toHaveCount(1);
  await bar.getByRole("group", { name: "People" }).getByRole("link", { name: /^Edil/ }).click();
  await expect(page).toHaveURL(new RegExp(`who=person%3A${edil}`));
  await expect(row).toBeVisible();

  // Filter → Priority → High: a removable pill; Done view hides it; Back brings it back.
  await bar.getByRole("button", { name: "Add a filter" }).click();
  await page.getByRole("listbox", { name: "Add a filter" }).getByRole("option", { name: "Priority" }).click();
  await page.getByRole("listbox", { name: "Filter by priority" }).getByRole("option", { name: "High" }).click();
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/priority=high/);
  await expect(bar.getByTestId("filter-pill")).toContainText("Priority");
  await expect(row).toBeVisible();
  await bar.getByRole("navigation", { name: "Views" }).getByRole("link", { name: /^Backlog/ }).click();
  await expect(page).toHaveURL(/view=backlog/);
  await expect(row).toHaveCount(0);
  await page.goBack();
  await expect(row).toBeVisible();

  // Company → people: with Upsell Group chosen, Edil's chip is gone.
  await page.goto(`/tasks?company=${companies.data.find((c) => c.slug === "upsell-group")!.id}`);
  await expect(bar.getByRole("group", { name: "People" }).getByRole("link", { name: /Edil/ })).toHaveCount(0);
  await page.goto(`/tasks?company=${jobutify}`);
  await expect(bar.getByRole("group", { name: "People" }).getByRole("link", { name: /Edil/ })).toBeVisible();

  // Display: group by assignee, in the URL.
  await bar.getByRole("button", { name: "Display" }).click();
  await page.getByRole("dialog", { name: "Display options" }).getByLabel("Grouping").selectOption("assignee");
  await expect(page).toHaveURL(/group=assignee/);
  await expect(page.getByRole("region", { name: /^Edil \(\d+\)$/ })).toBeVisible();

  // My filters: save the current filters as a chip, clear everything, come back through the chip, remove it.
  await page.goto(`/tasks?who=person%3A${edil}&priority=high&search=${encodeURIComponent(title)}`);
  const filtered = page.url();
  const mine = bar.getByRole("group", { name: "My filters" });
  await mine.getByRole("button", { name: "+ Save current" }).click();
  await mine.getByLabel("Name of the saved filter").fill("Edil high");
  await mine.getByRole("button", { name: "Save" }).click();
  await expect(mine.getByRole("link", { name: "Edil high" })).toBeVisible();
  await bar.getByRole("link", { name: "Clear" }).click();
  await expect(page).toHaveURL(/\/tasks$/);
  await page.reload();
  await mine.getByRole("link", { name: "Edil high" }).click();
  for (const part of new URL(filtered).searchParams.keys()) await expect(page).toHaveURL(new RegExp(`[?&]${part}=`));
  await expect(row).toBeVisible();
  await mine.getByRole("button", { name: "Remove saved filter Edil high" }).click();
  await expect(mine.getByRole("link", { name: "Edil high" })).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  await noSideScroll(page);
  await page.setViewportSize({ width: 1280, height: 800 });

  // Clean up.
  const all = (await (await page.request.get("/api/v1/tasks?status=any&limit=500")).json()) as { data: { id: string; title: string }[] };
  for (const t of all.data.filter((x) => x.title.includes(String(stamp)))) await page.request.delete(`/api/v1/tasks/${t.id}`);
});

test("Routines: view chips with counts, person chips, Filter, search, grouped by status", async ({ page }) => {
  await login(page, "nuraaly");
  await page.goto("/routines");
  const bar = page.getByRole("search", { name: "Filter routines" });
  const active = bar.getByRole("navigation", { name: "Views" }).getByRole("link", { name: /^Active \d+$/ });
  await expect(active).toHaveAttribute("aria-current", "page");
  const n = Number((await active.textContent())!.match(/\d+/)![0]);
  await expect(page.getByTestId("routine-row")).toHaveCount(n);
  await expect(bar.getByRole("link", { name: /^All \d+$/ })).toBeVisible();
  await expect(page.getByTestId("group-header").first()).toContainText("Active");

  const first = page.getByTestId("routine-row").first();
  const title = (await first.getByRole("link").first().textContent())!.trim();
  await bar.getByRole("searchbox", { name: "Search" }).fill(title.slice(0, 8));
  await bar.getByRole("searchbox", { name: "Search" }).press("Enter");
  await expect(page).toHaveURL(/search=/);
  await expect(page.getByTestId("routine-row").filter({ hasText: title })).toBeVisible();

  // Filter → Run → Has comments, then remove the pill.
  await bar.getByRole("button", { name: "Add a filter" }).click();
  await page.getByRole("listbox", { name: "Add a filter" }).getByRole("option", { name: "Run" }).click();
  await page.getByRole("listbox", { name: "Filter by run" }).getByRole("option", { name: "Has comments" }).click();
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/quick=comments/);
  await bar.getByRole("button", { name: "Remove filter Run" }).click();
  await expect(page).not.toHaveURL(/quick=/);

  // Company → people: Kiwi Go keeps Elmurat's chip.
  const kiwi = ((await (await page.request.get("/api/v1/companies")).json()) as { data: { id: string; slug: string }[] }).data.find((c) => c.slug === "kiwi-go")!.id;
  await page.goto(`/routines?company=${kiwi}`);
  await expect(bar.getByRole("group", { name: "People" }).getByRole("link", { name: /Elmurat/ })).toBeVisible();

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
  await row.getByRole("button", { name: `More actions for ${title}` }).click();
  await page.getByRole("listbox", { name: `More actions for ${title}` }).getByRole("option", { name: "Edit…" }).click();
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
  await expect(row.getByLabel("Sub-tasks 0 of 2 done")).toBeVisible();

  // The task page: the same order; move it back down.
  await row.getByTestId("task-title").click();
  const pageList = page.getByTestId("task-checklist");
  await expect(pageList.getByTestId("checklist-item").first()).toContainText("Второй");
  await pageList.getByRole("button", { name: "Move “Второй” down" }).click();
  await expect(pageList.getByTestId("checklist-item").first()).toContainText("Первый");
  await expect(page.getByRole("list", { name: "Timeline" }).getByText(/Sub-task moved/).first()).toBeVisible();
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
