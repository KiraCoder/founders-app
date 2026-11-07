import { expect, test, type Page } from "@playwright/test";
import { login } from "./helpers";

/**
 * Actions revalidate only the touched entity's tag (no layout-wide revalidate): the calling page
 * (layout included) must still show the change, and other pages must be fresh on the next visit.
 * One-tap actions are optimistic: they show before the server answers and roll back with a toast
 * when it fails. Server actions are POSTs with a `next-action` header; `slowActions` delays them
 * so the optimistic state can be seen, `failActions` makes them fail.
 */
async function slowActions(page: Page, ms = 1500) {
  await page.route("**/*", async (route) => {
    if (route.request().method() === "POST" && route.request().headers()["next-action"]) await new Promise((r) => setTimeout(r, ms));
    await route.continue();
  });
}
async function failActions(page: Page) {
  await page.route("**/*", (route) =>
    route.request().method() === "POST" && route.request().headers()["next-action"] ? route.abort() : route.continue(),
  );
}
const normalActions = (page: Page) => page.unrouteAll({ behavior: "ignoreErrors" });

test("Today: quick add, Done (optimistic, rollback on failure), Reopen on Tasks, back on Today; checklist ticks", async ({ page }) => {
  const title = `[e2e] refresh ${Date.now()}`;
  await login(page, "nuraaly");

  // Quick add on Today: the new todo is listed without a reload.
  await page.getByLabel("New personal todo").fill(title);
  await page.getByRole("form", { name: "Quick add" }).getByRole("button", { name: "Add" }).click();
  const row = page.locator("li[data-task-id]", { hasText: title });
  await expect(row).toBeVisible();

  // A failing Done: shown at once, then rolled back with a toast.
  await failActions(page);
  await row.getByRole("button", { name: "Mark done" }).click();
  await expect(page.getByTestId("toast").filter({ hasText: "Could not reach the server" })).toBeVisible();
  await expect(row.getByRole("button", { name: "Mark done" })).toBeVisible();
  await expect(row).toContainText("To do");
  await normalActions(page);

  // A slow Done: the row says Done before the server answers; then the todo leaves Today's open lists.
  await slowActions(page);
  await row.getByRole("button", { name: "Mark done" }).click();
  await expect(row.getByRole("button", { name: "Reopen" })).toHaveAttribute("aria-pressed", "true", { timeout: 1000 });
  await expect(row).toContainText("Done", { timeout: 1000 });
  await expect(row).toHaveCount(0);
  await normalActions(page);

  // Another page reads it fresh: Done on Tasks; Reopen there → back on Today.
  await page.goto("/tasks?view=my&status=any");
  const onTasks = page.locator("li[data-task-id]", { hasText: title });
  await expect(onTasks).toContainText("Done");
  await onTasks.getByRole("button", { name: "Reopen" }).click();
  await expect(onTasks).toContainText("To do");
  await page.getByRole("link", { name: "Today" }).first().click();
  await expect(page.locator("li[data-task-id]", { hasText: title })).toBeVisible();

  // Checklist on the task page: a slow tick shows at once ("saving…"), then who ticked it; a failing one rolls back.
  await page.locator("li[data-task-id]", { hasText: title }).getByRole("link", { name: "Open", exact: true }).click();
  const checklist = page.getByTestId("task-checklist");
  for (const item of ["Первый", "Второй"]) {
    await checklist.getByLabel("Item", { exact: true }).fill(item);
    await checklist.getByRole("button", { name: "+ Add item" }).click();
    await expect(checklist.getByTestId("checklist-item").filter({ hasText: item })).toBeVisible();
  }
  await slowActions(page);
  await checklist.getByRole("checkbox", { name: "Tick “Первый”" }).check();
  await expect(checklist.getByTestId("checklist-done-meta")).toContainText("saving…", { timeout: 1000 });
  // A second tick while the first is in flight.
  await checklist.getByRole("checkbox", { name: "Tick “Второй”" }).check();
  await expect(checklist.getByLabel("2 of 2 done")).toBeVisible({ timeout: 1000 });
  await expect(checklist.getByTestId("checklist-done-meta").first()).toContainText("Nuraaly");
  await expect(checklist.getByTestId("checklist-done-meta").nth(1)).toContainText("Nuraaly");
  await normalActions(page);
  await failActions(page);
  await checklist.getByRole("checkbox", { name: "Untick “Второй”" }).uncheck();
  await expect(page.getByTestId("toast").filter({ hasText: "Could not reach the server" }).first()).toBeVisible();
  await expect(checklist.getByRole("checkbox", { name: "Untick “Второй”" })).toBeChecked();
  await normalActions(page);

  // Clean up.
  const { data } = (await (await page.request.get("/api/v1/tasks?view=my&status=any")).json()) as { data: { id: string; title: string }[] };
  const id = data.find((t) => t.title === title)!.id;
  expect((await page.request.delete(`/api/v1/tasks/${id}`)).ok()).toBeTruthy();
});

test("Routines: Pause / Resume are optimistic; the routine page and the list stay in step", async ({ page }) => {
  await login(page, "nuraaly");
  await page.goto("/routines");
  const first = page.getByTestId("routine-row").filter({ has: page.getByRole("button", { name: "Pause", exact: true }) }).first();
  const title = (await first.getByRole("link").first().textContent())!.trim();
  const row = page.getByTestId("routine-row").filter({ has: page.getByRole("link", { name: title, exact: true }) });

  await slowActions(page);
  await row.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(row.getByText("Paused", { exact: true })).toBeVisible({ timeout: 1000 });
  await expect(row.getByRole("button", { name: "Resume", exact: true })).toBeVisible({ timeout: 1000 });
  await expect(row.getByRole("button", { name: "Run now" })).toHaveCount(0);
  await expect(page.getByTestId("toast").filter({ hasText: "Paused" })).toBeVisible();
  await normalActions(page);

  // The routine page (another page) is fresh; Resume there; the list follows.
  await row.getByRole("link", { name: title, exact: true }).click();
  await expect(page).toHaveURL(/\/routines\/[0-9a-f-]{36}/);
  const header = page.locator("header").filter({ has: page.getByRole("heading", { name: title }) });
  await expect(header.getByText("Paused", { exact: true })).toBeVisible();
  await header.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(header.getByText("Active", { exact: true })).toBeVisible();
  await expect(page.getByTestId("toast").filter({ hasText: "Active again" })).toBeVisible();
  await page.goto("/routines");
  await expect(row.getByText("Active", { exact: true })).toBeVisible();
});

test("Settings → Companies: the sidebar's company switcher follows add / rename / delete without a reload", async ({ page }) => {
  const name = `E2E Sidebar ${Date.now().toString(36)}`;
  await login(page, "nuraaly");
  await page.goto("/settings/companies");
  await page.getByTestId("add-company").click();
  const form = page.getByTestId("new-company-form");
  await form.getByLabel("Name", { exact: true }).fill(name);
  await form.getByRole("button", { name: "Add company" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Added." })).toBeVisible();

  const switcher = page.getByRole("button", { name: /Switch company/ }).first();
  await switcher.click();
  await expect(page.getByRole("menu", { name: "Switch company" }).getByRole("menuitem", { name: name })).toBeVisible();
  await page.keyboard.press("Escape");

  const row = page.locator("li[data-testid^='company-row-']", { hasText: name });
  await row.getByRole("button", { name: "Edit", exact: true }).click();
  await row.getByLabel("Name", { exact: true }).fill(`${name} renamed`);
  await row.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
  await switcher.click();
  await expect(page.getByRole("menu", { name: "Switch company" }).getByRole("menuitem", { name: `${name} renamed` })).toBeVisible();
  await page.keyboard.press("Escape");

  page.once("dialog", (d) => d.accept());
  await page.locator("li[data-testid^='company-row-']", { hasText: `${name} renamed` }).getByRole("button", { name: `Delete ${name} renamed` }).click();
  await expect(page.locator("li[data-testid^='company-row-']", { hasText: name })).toHaveCount(0);
  await switcher.click();
  await expect(page.getByRole("menu", { name: "Switch company" }).getByRole("menuitem", { name: new RegExp(name) })).toHaveCount(0);
});
