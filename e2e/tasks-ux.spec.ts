import { expect, test, type Page } from "@playwright/test";
import { login } from "./helpers";

const noSideScroll = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);

/** Opens a row / sidebar picker and picks an option (the menus are listboxes named like their trigger). */
async function pick(page: Page, scope: ReturnType<Page["locator"]>, trigger: string, option: string | RegExp) {
  await scope.getByRole("button", { name: trigger }).first().click();
  await page.getByRole("listbox", { name: trigger }).getByRole("option", { name: option }).first().click();
}

test("tasks: + New dialog (assignee limits companies, sub-tasks, chase, estimate) → Linear row edited inline → task page → archive", async ({ page }) => {
  const title = `[e2e] tasks ux ${Date.now()}`;
  await login(page, "nuraaly");
  await page.goto("/tasks");

  // "+ New" opens the form in a dialog.
  await page.getByRole("button", { name: "New task" }).click();
  const dialog = page.getByRole("dialog", { name: "New task" });
  await expect(dialog).toBeVisible();
  const form = dialog.getByRole("form", { name: "New task" });
  await form.getByLabel("Title").fill(title);
  await form.getByLabel("Who sees it").selectOption("shared");

  // Elmurat works for five companies: only those are offered. Edil works for one: it is picked.
  await form.getByLabel("Assignee").selectOption({ label: "Elmurat" });
  await expect(form.getByLabel("Company").locator("option")).toHaveCount(6);
  await expect(form.getByText("Only Elmurat's 5 companies")).toBeVisible();
  await form.getByLabel("Assignee").selectOption({ label: "Edil" });
  await expect(form.getByLabel("Company").locator("option:checked")).toHaveText("Jobutify");
  await expect(form.getByRole("checkbox", { name: /Needs review/ })).toBeChecked();

  await form.getByLabel("Due date", { exact: true }).first().fill("15.01.2027");
  await form.getByLabel("Estimate").selectOption("3");
  // Sub-tasks one by one.
  await form.getByLabel("New checklist item").fill("Акт сверки");
  await form.getByRole("button", { name: "+ Add item" }).click();
  await form.getByLabel("New checklist item").fill("Счёт");
  await form.getByRole("button", { name: "+ Add item" }).click();
  await expect(form.getByRole("list", { name: "Checklist" }).locator("li")).toHaveCount(2);

  // Chase made explicit, with a live summary.
  await form.getByText("Remind once on the due date").click();
  await expect(form.getByTestId("chase-summary")).toContainText("Edil gets one reminder on the due date");
  await form.getByRole("button", { name: "Add task" }).click();
  await expect(page.getByTestId("toast").filter({ hasText: "Task created" })).toBeVisible();
  await expect(dialog).toBeHidden();

  // The row: key, Todo group, assignee, company, ▲ 3, sub-task progress.
  const row = page.locator("li[data-task-id]", { hasText: title });
  await expect(row.getByTestId("task-key")).toHaveText(/^[A-Z][A-Z0-9]+-\d+$/);
  await expect(page.getByRole("region", { name: /^Todo/ }).locator("li[data-task-id]", { hasText: title })).toBeVisible();
  await expect(row.getByRole("button", { name: "Change assignee" })).toHaveAttribute("title", "Assignee: Edil");
  await expect(row).toContainText("Jobutify");
  await expect(row.getByRole("button", { name: "Change estimate" })).toContainText("3");
  await expect(row.getByLabel("Sub-tasks 0 of 2 done")).toBeVisible();

  // Inline, optimistic: status → In Progress moves the row to its group at once.
  await pick(page, row, "Change status", "In Progress");
  await expect(page.getByRole("region", { name: /^In Progress/ }).locator("li[data-task-id]", { hasText: title })).toBeVisible();
  // Priority → Urgent; estimate → 5; a new label created from the picker.
  await pick(page, row, "Change priority", "Urgent");
  await expect(row.getByRole("button", { name: "Change priority" })).toHaveAttribute("title", "Priority: Urgent");
  await pick(page, row, "Change estimate", "5 points");
  await expect(row.getByRole("button", { name: "Change estimate" })).toContainText("5");
  const label = `E2E ${Date.now().toString(36)}`;
  await row.getByRole("button", { name: "Change labels" }).click();
  const labels = page.getByRole("listbox", { name: "Change labels" });
  await page.getByRole("textbox", { name: "Search: Change labels" }).fill(label);
  await labels.getByRole("option", { name: `Create label “${label}”` }).click();
  await page.keyboard.press("Escape");
  await expect(row.getByTestId("label-chip").filter({ hasText: label })).toBeVisible();
  // Keyboard: focus the row, "p" opens priority, "3" picks the third option (High).
  await row.focus();
  await page.keyboard.press("p");
  await expect(page.getByRole("textbox", { name: "Search: Change priority" })).toBeFocused();
  await page.keyboard.press("3");
  await expect(row.getByRole("button", { name: "Change priority" })).toHaveAttribute("title", "Priority: High");
  // After a reload the server has every change (wait for the saves in flight first).
  await page.waitForLoadState("networkidle");
  await page.reload();
  const fresh = page.locator("li[data-task-id]", { hasText: title });
  await expect(fresh.getByRole("button", { name: "Change status" })).toHaveAttribute("title", "Status: In Progress");
  await expect(fresh.getByRole("button", { name: "Change priority" })).toHaveAttribute("title", "Priority: High");
  await expect(fresh.getByTestId("label-chip").filter({ hasText: label })).toBeVisible();

  // The "⋯" menu: Pause chasing → toast; Edit in a dialog.
  await pick(page, fresh, `More actions for ${title}`, "Pause chasing");
  await expect(page.getByTestId("toast").filter({ hasText: "Chasing paused" })).toBeVisible();
  await pick(page, fresh, `More actions for ${title}`, "Edit…");
  const editDialog = page.getByRole("dialog", { name: "Edit task" });
  await editDialog.getByLabel("Title").fill(`${title} (edited)`);
  await editDialog.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByTestId("toast").filter({ hasText: "Saved" })).toBeVisible();
  const edited = page.locator("li[data-task-id]", { hasText: `${title} (edited)` });

  // Task page: back, key, editable title, Markdown description, properties, sub-tasks, activity, comment.
  await edited.getByTestId("task-title").click();
  await expect(page).toHaveURL(/\/tasks\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("link", { name: "Back to tasks" })).toBeVisible();
  await expect(page.getByTestId("task-details")).toContainText("Jobutify");
  await page.getByRole("button", { name: "Edit description" }).click();
  await page.getByRole("textbox", { name: "Description" }).fill("## Steps\n- [ ] call **Edil**\n- [x] send the file");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const md = page.getByTestId("markdown");
  await expect(md.getByRole("heading", { name: "Steps" })).toBeVisible();
  await expect(md.locator("strong", { hasText: "Edil" })).toBeVisible();
  await md.getByRole("checkbox", { name: "Tick call Edil" }).check();
  await expect(md.getByRole("checkbox", { name: "Untick call Edil" })).toBeChecked();
  const titleBox = page.getByTestId("task-title-input");
  await titleBox.fill(`${title} (renamed)`);
  await titleBox.press("Enter");
  await expect(page.getByTestId("toast").filter({ hasText: "Title saved" })).toBeVisible();
  // Properties sidebar: due date → Tomorrow (the menu), needs review off.
  const props = page.getByTestId("task-properties");
  await pick(page, props, "Change due date", "Tomorrow");
  await expect(props.getByRole("button", { name: "Change due date" })).toContainText("Tomorrow");
  await props.getByRole("checkbox", { name: "Needs review" }).uncheck();
  await expect(page.getByTestId("toast").filter({ hasText: "Needs review: off" })).toBeVisible();
  const checklist = page.getByTestId("task-checklist");
  await checklist.getByRole("checkbox", { name: "Tick “Акт сверки”" }).check();
  await expect(checklist.getByTestId("checklist-done-meta")).toContainText("Nuraaly");
  await page.getByRole("textbox", { name: "New comment" }).fill("Проверь акт, пожалуйста");
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  const comment = page.getByTestId("task-comment").filter({ hasText: "Проверь акт" });
  await expect(comment).toBeVisible();
  await comment.getByRole("button", { name: "Edit" }).click();
  await comment.getByRole("textbox", { name: "Comment text" }).fill("Проверь акт сегодня");
  await comment.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("task-comment").filter({ hasText: "Проверь акт сегодня" })).toContainText("(edited)");
  const timeline = page.getByRole("list", { name: "Timeline" });
  await expect(timeline.getByText("Status: Todo → In Progress")).toBeVisible();
  await expect(timeline.getByText(/Sub-task ticked/)).toBeVisible();
  await expect(timeline.getByText(/Labels: added/)).toBeVisible();
  await expect(page.getByTestId("chase-details")).toBeVisible();

  // Phone width: no sideways scroll on the task page.
  await page.setViewportSize({ width: 390, height: 844 });
  await noSideScroll(page);
  await page.setViewportSize({ width: 1280, height: 800 });

  // Archive asks first.
  await page.getByRole("button", { name: "Archive", exact: true }).click();
  const confirm = page.getByRole("alertdialog", { name: "Archive this task?" });
  await expect(confirm).toContainText("No more reminders go to Edil");
  await confirm.getByRole("button", { name: "Archive" }).click();
  await expect(page.getByTestId("toast").filter({ hasText: "Archived" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Restore", exact: true })).toBeVisible();

  // Back → the list (phone: no sideways scroll there either).
  await page.getByRole("link", { name: "Back to tasks" }).click();
  await expect(page).toHaveURL(/\/tasks$/);
  await page.setViewportSize({ width: 390, height: 844 });
  await noSideScroll(page);
});

test("tasks: multi-select (checkbox + shift-click) and the bulk bar; '+' adds a task straight into a group", async ({ page }) => {
  const stamp = Date.now();
  await login(page, "nuraaly");
  for (const n of [1, 2, 3]) {
    expect((await page.request.post("/api/v1/tasks", { data: { title: `[e2e] bulk ${stamp} ${n}`, visibility: "private" } })).status()).toBe(201);
  }
  await page.goto(`/tasks?search=${encodeURIComponent(`[e2e] bulk ${stamp}`)}&order=created`);
  const rows = page.locator("li[data-task-id]");
  await expect(rows).toHaveCount(3);
  await rows.nth(0).getByRole("checkbox").click({ force: true });
  await rows.nth(2).getByRole("checkbox").click({ force: true, modifiers: ["Shift"] });
  const bar = page.getByRole("toolbar", { name: "3 selected" });
  await expect(bar).toBeVisible();
  await bar.getByRole("button", { name: "Set priority of selected" }).click();
  await page.getByRole("listbox", { name: "Set priority of selected" }).getByRole("option", { name: "Low" }).click();
  await expect(page.getByTestId("toast").filter({ hasText: "3 tasks updated" })).toBeVisible();
  await bar.getByRole("button", { name: "Set status of selected" }).click();
  await page.getByRole("listbox", { name: "Set status of selected" }).getByRole("option", { name: "Backlog" }).click();
  await expect(page.getByTestId("toast").filter({ hasText: "3 tasks updated" })).toBeVisible();
  // They left the Active view; the Backlog view has them, priority Low.
  await page.goto(`/tasks?view=backlog&search=${encodeURIComponent(`[e2e] bulk ${stamp}`)}`);
  await expect(rows).toHaveCount(3);
  for (let i = 0; i < 3; i++) await expect(rows.nth(i).getByRole("button", { name: "Change priority" })).toHaveAttribute("title", "Priority: Low");

  // "+" in the Backlog group: a personal todo straight into Backlog.
  await page.getByRole("button", { name: "Add a task to Backlog" }).click();
  await page.getByRole("textbox", { name: "New task title" }).fill(`[e2e] bulk ${stamp} 4`);
  await page.getByRole("textbox", { name: "New task title" }).press("Enter");
  await expect(page.getByTestId("toast").filter({ hasText: /^ME-\d+ created \(personal\)/ })).toBeVisible();
  await expect(rows).toHaveCount(4);

  // Bulk delete (asks first).
  await rows.nth(0).getByRole("checkbox").click({ force: true });
  await rows.nth(3).getByRole("checkbox").click({ force: true, modifiers: ["Shift"] });
  await page.getByRole("toolbar", { name: "4 selected" }).getByRole("button", { name: "Delete" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Yes, delete" }).click();
  await expect(page.getByTestId("toast").filter({ hasText: "4 tasks deleted" })).toBeVisible();
  await expect(rows).toHaveCount(0);
});
