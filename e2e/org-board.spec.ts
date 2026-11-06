import { expect, test } from "@playwright/test";
import { login } from "./helpers";

/**
 * The org board like the old cockpit: tinted division columns, post chips (held / hiring),
 * «Показать посты» and the journey strip (Upsell template, link a step, click to highlight).
 */

test("posts: add a hiring post, give it a person, Undo puts the hiring back", async ({ page }) => {
  await login(page, "nuraaly");
  await page.goto("/org?company=kiwi-go");
  const d5 = page.locator('[data-testid=org-department][data-number="5"]');
  await expect(d5).toBeVisible();
  // Division columns carry their own tint.
  const tints = await page.locator("[data-testid=org-division]").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.tint));
  expect(new Set(tints).size).toBe(tints.length);

  const role = `Менеджер e2e ${Date.now() % 100000}`;
  await d5.getByTestId("org-add-post").click();
  const editor = page.getByTestId("org-post-editor");
  await editor.getByLabel("Post title").fill(role);
  await editor.getByRole("radio", { name: "Hiring" }).click();
  await editor.getByLabel("Hiring for (role title)").fill(role);
  await editor.getByRole("button", { name: "Add post" }).click();
  const chip = d5.locator('[data-testid=org-post][data-state="hiring"]', { hasText: role });
  await expect(chip).toBeVisible();

  await chip.click();
  await page.getByTestId("org-post-editor").getByRole("radio", { name: "Person" }).click();
  const picker = page.getByTestId("org-post-editor").getByLabel("Person on this post", { exact: true });
  const elmurat = await picker.locator("option", { hasText: "Elmurat" }).first().getAttribute("value");
  await picker.selectOption(elmurat!);
  await page.getByTestId("org-post-editor").getByRole("button", { name: "Save" }).click();
  await expect(d5.locator('[data-testid=org-post][data-state="held"]', { hasText: "Elmurat" }).first()).toBeVisible();
  await expect(d5.locator('[data-testid=org-post][data-state="hiring"]', { hasText: role })).toHaveCount(0);

  // «Показать посты»: Elmurat's department lights up.
  await page.getByTestId("org-person-filter").getByRole("button", { name: /^Elmurat/ }).click();
  await expect(d5).toHaveAttribute("data-lit", "1");
  await page.getByTestId("org-person-filter").getByRole("button", { name: "Все" }).click();

  await page.getByRole("button", { name: /^Undo/ }).click();
  await expect(d5.locator('[data-testid=org-post][data-state="hiring"]', { hasText: role })).toBeVisible();
  await page.reload();
  await expect(d5.locator('[data-testid=org-post][data-state="hiring"]', { hasText: role })).toBeVisible();
  // Clean up: remove the post.
  await d5.locator('[data-testid=org-post][data-state="hiring"]', { hasText: role }).click();
  await page.getByTestId("org-post-editor").getByRole("button", { name: "Remove post" }).click();
  await expect(d5.locator("[data-testid=org-post]", { hasText: role })).toHaveCount(0);
});

test("journey: Upsell template, link a step to a department, click it to highlight", async ({ page }) => {
  await login(page, "nuraaly");
  await page.goto("/org?company=upsell-group");
  if (await page.getByTestId("org-empty").isVisible()) {
    await page.getByRole("button", { name: /Apply Vysotsky template/ }).click();
    await expect(page.getByTestId("org-board")).toBeVisible();
  }
  const strip = page.getByTestId("org-journey");
  await expect(strip).toBeVisible();
  const template = page.getByTestId("org-journey-template");
  if (await template.isVisible()) await template.click();
  const steps = strip.getByTestId("org-journey-step");
  await expect(steps).toHaveCount(9);
  await expect(steps.first()).toContainText("01");
  await expect(steps.first()).toContainText("Фабрика найдена");
  await expect(steps.nth(8)).toContainText("Деньги и 5% Upsell");

  await strip.getByRole("button", { name: "Edit journey" }).click();
  await strip.getByRole("combobox", { name: "Department of step 01" }).selectOption({ index: 5 });
  await expect.poll(async () => (await strip.getByRole("combobox", { name: "Department of step 01" }).inputValue()).length).toBeGreaterThan(0);
  const deptId = await strip.getByRole("combobox", { name: "Department of step 01" }).inputValue();
  await strip.getByRole("button", { name: "Done" }).click();

  await steps.first().click();
  await expect(page.locator(`[data-testid=org-department][data-id="${deptId}"]`)).toHaveAttribute("data-lit", "1");
  await page.reload();
  await expect(page.getByTestId("org-journey-step").first()).not.toContainText("отдел не выбран");
});
