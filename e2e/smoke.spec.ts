import { expect, test } from "@playwright/test";
import { login, logout } from "./helpers";

test("login → create personal todo → visible in My tasks → hidden from the other founder", async ({ page }) => {
  const title = `[e2e] private todo ${Date.now()}`;

  // Unauthenticated users are sent to /login.
  await page.goto("/tasks");
  await expect(page).toHaveURL(/\/login/);

  await login(page, "nuraaly");

  // Create a personal todo on the Tasks page ("My todos" view defaults to private).
  await page.goto("/tasks");
  await page.getByRole("button", { name: "New task" }).click();
  const form = page.getByRole("form", { name: "New task" });
  await form.getByLabel("Title").fill(title);
  await expect(form.locator('select[name="visibility"]')).toHaveValue("private");
  await form.getByRole("button", { name: "Add task" }).click();

  const row = page.locator("li", { hasText: title });
  await expect(row).toBeVisible();
  await expect(row.getByText("Personal")).toBeVisible();

  // Also on Today under "My personal todos".
  await page.goto("/");
  await expect(page.getByText(title)).toBeVisible();

  // Find its id through the REST API (same session cookie).
  const api = await page.request.get("/api/v1/tasks?view=my");
  expect(api.ok()).toBeTruthy();
  const { data } = (await api.json()) as { data: { id: string; title: string }[] };
  const id = data.find((t) => t.title === title)?.id;
  expect(id).toBeTruthy();

  await logout(page);

  // Talant cannot see it anywhere.
  await login(page, "talant");
  await expect(page.getByText(title)).toHaveCount(0);
  await page.goto("/tasks?view=my");
  await expect(page.getByText(title)).toHaveCount(0);
  await page.goto("/tasks?view=company&status=any");
  await expect(page.getByText(title)).toHaveCount(0);
  await page.goto(`/search?q=${encodeURIComponent(title)}`);
  await expect(page.getByText("Nothing found.")).toBeVisible();
  const forbidden = await page.request.get(`/api/v1/tasks/${id}`);
  expect(forbidden.status()).toBe(404);
  await logout(page);

  // Clean up through the in-page delete confirmation.
  await login(page, "nuraaly");
  await page.goto("/tasks");
  const mine = page.locator("li", { hasText: title });
  await mine.getByRole("button", { name: "Edit" }).click();
  await mine.getByRole("button", { name: "Delete task…" }).click();
  await mine.getByRole("button", { name: "Yes, delete" }).click();
  await expect(page.getByText(title)).toHaveCount(0);
});
