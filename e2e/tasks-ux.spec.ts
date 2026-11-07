import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test("tasks: + New dialog (assignee limits companies, checklist, explicit chase) → list control center → task page → archive", async ({ page }) => {
  const title = `[e2e] tasks ux ${Date.now()}`;
  await login(page, "nuraaly");
  await page.goto("/tasks?view=company");

  // "+ New" opens the form in a dialog.
  await page.getByRole("button", { name: "New task" }).click();
  const dialog = page.getByRole("dialog", { name: "New task" });
  await expect(dialog).toBeVisible();
  const form = dialog.getByRole("form", { name: "New task" });
  await form.getByLabel("Title").fill(title);

  // Elmurat works for five companies: only those are offered. Edil works for one: it is picked.
  await form.getByLabel("Assignee").selectOption({ label: "Elmurat" });
  await expect(form.getByLabel("Company").locator("option")).toHaveCount(6);
  await expect(form.getByText("Only Elmurat's 5 companies")).toBeVisible();
  await form.getByLabel("Assignee").selectOption({ label: "Edil" });
  await expect(form.getByLabel("Company").locator("option:checked")).toHaveText("Jobutify");

  await form.getByLabel("Due date", { exact: true }).first().fill("15.01.2027");
  // Checklist items one by one.
  await form.getByLabel("New checklist item").fill("Акт сверки");
  await form.getByRole("button", { name: "+ Add item" }).click();
  await form.getByLabel("New checklist item").fill("Счёт");
  await form.getByRole("button", { name: "+ Add item" }).click();
  await expect(form.getByRole("list", { name: "Checklist" }).locator("li")).toHaveCount(2);

  // Chase made explicit, with a live summary.
  await form.getByText("Remind once on the due date").click();
  await expect(form.getByTestId("chase-summary")).toContainText("Edil gets one reminder on the due date");
  await form.getByText("If still open N days after due").click();
  await form.getByRole("spinbutton", { name: "Days after due" }).fill("3");
  await expect(form.getByTestId("chase-summary")).toContainText("still open 3 days after the due date, both founders are told");
  await form.getByRole("button", { name: "Add task" }).click();
  await expect(page.getByTestId("toast").filter({ hasText: "Task created" })).toBeVisible();
  await expect(dialog).toBeHidden();

  // The row: status, assignee, company, checklist progress and icon buttons with names.
  const row = page.locator("li[data-task-id]", { hasText: title });
  await expect(row).toContainText("To do");
  await expect(row).toContainText("Edil");
  await expect(row).toContainText("Jobutify");
  await expect(row.getByLabel("Checklist 0 of 2 done")).toBeVisible();
  await expect(row.getByText("Remind once")).toBeVisible();
  for (const name of ["Mark done", "Edit", "Open", "Chase Edil now", "Pause chasing", "Archive"]) {
    await expect(row.getByRole(name === "Open" ? "link" : "button", { name, exact: true })).toBeVisible();
  }

  // Pause chasing → toast, the row says so; resume.
  await row.getByRole("button", { name: "Pause chasing" }).click();
  await expect(page.getByTestId("toast").filter({ hasText: "Chasing paused" })).toBeVisible();
  await expect(row.getByText("⏸ Chasing paused")).toBeVisible();
  await row.getByRole("button", { name: "Resume chasing" }).click();
  await expect(row.getByText("⏸ Chasing paused")).toHaveCount(0);

  // Edit in a dialog: inline error for an empty title is the browser's (required); a real change saves.
  await row.getByRole("button", { name: "Edit", exact: true }).click();
  const editDialog = page.getByRole("dialog", { name: "Edit task" });
  await editDialog.getByLabel("Title").fill(`${title} (edited)`);
  await editDialog.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByTestId("toast").filter({ hasText: "Saved" })).toBeVisible();
  const edited = page.locator("li[data-task-id]", { hasText: `${title} (edited)` });

  // Task page: back link, details, checklist ticks with time + who, timeline.
  await edited.getByRole("link", { name: "Open", exact: true }).click();
  await expect(page).toHaveURL(/\/tasks\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("link", { name: "Back to tasks" })).toBeVisible();
  await expect(page.getByTestId("task-details")).toContainText("Jobutify");
  const checklist = page.getByTestId("task-checklist");
  await checklist.getByRole("checkbox", { name: "Tick “Акт сверки”" }).check();
  await expect(checklist.getByTestId("checklist-done-meta")).toContainText("Nuraaly");
  await checklist.getByLabel("Item", { exact: true }).fill("Подписи");
  await checklist.getByRole("button", { name: "+ Add item" }).click();
  await expect(checklist.getByTestId("checklist-item")).toHaveCount(3);
  await expect(page.getByRole("radio", { name: "Remind once on the due date" })).toBeChecked();
  const timeline = page.getByRole("list", { name: "Timeline" });
  await expect(timeline.getByText("Created")).toBeVisible();
  await expect(timeline.getByText(/Checklist: ticked/)).toBeVisible();

  // Phone width: no sideways scroll on the task page.
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.setViewportSize({ width: 1280, height: 800 });

  // Archive asks first.
  await page.getByRole("button", { name: "Archive", exact: true }).click();
  const confirm = page.getByRole("alertdialog", { name: "Archive this task?" });
  await expect(confirm).toContainText("No more reminders go to Edil");
  await confirm.getByRole("button", { name: "Archive" }).click();
  await expect(page.getByTestId("toast").filter({ hasText: "Archived" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Restore", exact: true })).toBeVisible();

  // Back → the list.
  await page.getByRole("link", { name: "Back to tasks" }).click();
  await expect(page).toHaveURL(/\/tasks\?view=company/);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});
