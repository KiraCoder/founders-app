import { expect, test } from "@playwright/test";
import { login, logout } from "./helpers";

test("Team view: grouped by person with counts, private todos stay private, person page Tasks + Assign a task", async ({ page }) => {
  const stamp = Date.now();
  await login(page, "nuraaly");
  const companies = (await (await page.request.get("/api/v1/companies")).json()) as { data: { id: string; slug: string }[] };
  const kiwi = companies.data.find((c) => c.slug === "kiwi-go")!;
  const people = (await (await page.request.get("/api/v1/people?q=Elmurat")).json()) as { data: { id: string; fullName: string }[] };
  const elmurat = people.data.find((p) => p.fullName === "Elmurat")!;

  const secret = `[e2e] Nuraaly secret ${stamp}`;
  const overdue = `[e2e] Elmurat overdue ${stamp}`;
  const nobody = `[e2e] Nobody ${stamp}`;
  for (const data of [
    { title: secret, visibility: "private" },
    { title: overdue, visibility: "shared", companyId: kiwi.id, assigneePersonId: elmurat.id, dueDate: "2026-01-01" },
    { title: nobody, visibility: "shared", companyId: kiwi.id },
  ]) {
    expect((await page.request.post("/api/v1/tasks", { data })).status()).toBe(201);
  }

  // Nuraaly sees her own todo in her own group.
  await page.goto("/tasks?view=team");
  await expect(page.getByRole("link", { name: "Team", exact: true })).toHaveAttribute("aria-current", "page");
  const groups = page.getByTestId("team-group");
  await expect(groups.first()).toContainText("Nuraaly");
  await expect(groups.first()).toContainText(secret);
  const elGroup = groups.filter({ has: page.getByRole("heading", { name: "Elmurat" }) });
  await expect(elGroup).toContainText(overdue);
  await expect(elGroup.getByTestId("team-telegram")).toBeVisible();
  await expect(groups.filter({ hasText: "Unassigned" })).toContainText(nobody);

  // Overdue-only filter.
  await page.getByLabel("Overdue only").check();
  await expect(page).toHaveURL(/overdue=1/);
  await expect(page.getByText(nobody)).toHaveCount(0);
  await expect(page.getByText(overdue)).toBeVisible();

  // Talant never sees Nuraaly's personal todo.
  await logout(page);
  await login(page, "talant");
  await page.goto("/tasks?view=team&status=any");
  await expect(page.getByText(overdue)).toBeVisible();
  await expect(page.getByText(secret)).toHaveCount(0);

  // Person page → Tasks section, Assign a task preset with Elmurat.
  await page.goto(`/people/${elmurat.id}`);
  const section = page.getByTestId("person-tasks");
  await expect(section.getByTestId("person-tasks-overdue")).toContainText(overdue);
  await section.getByRole("button", { name: "Assign a task" }).click();
  const form = section.getByRole("form", { name: "New task" });
  await expect(form.getByRole("combobox").filter({ has: page.locator('option[value^="person:"]') }).first()).toHaveValue(`person:${elmurat.id}`);
  const assigned = `[e2e] Assigned from person page ${stamp}`;
  await form.getByLabel("Title").fill(assigned);
  await form.getByRole("button", { name: "Add task" }).click();
  await expect(section.getByTestId("person-tasks-open")).toContainText(assigned);

  // Phone: groups stack in one column.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/tasks?view=team");
  const [a, b] = await Promise.all([groups.nth(0).boundingBox(), groups.nth(1).boundingBox()]);
  expect(b!.y).toBeGreaterThan(a!.y + a!.height - 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});
