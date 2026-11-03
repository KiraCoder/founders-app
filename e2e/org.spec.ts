import { expect, test, type Page } from "@playwright/test";
import { login } from "./helpers";

const functionsOf = (page: Page, n: number) =>
  page.locator(`[data-testid=org-department][data-number="${n}"] [data-testid=org-function]`).evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.text));

/** Which department holds a function right now (the seed puts “Testing” in 5 Продажи). */
async function departmentOf(page: Page, text: string): Promise<number> {
  return page
    .locator(`[data-testid=org-function][data-text="${text}"]`)
    .first()
    .evaluate((el) => Number((el.closest("[data-testid=org-department]") as HTMLElement).dataset.number));
}

test("org board: Kiwi Go, edit mode, move a function (keyboard path), reload, undo", async ({ page }) => {
  await login(page, "nuraaly");
  await page.goto("/org?company=kiwi-go");
  const d7 = page.locator('[data-testid=org-division][data-number="7"]');
  await expect(d7).toBeVisible();
  await expect(d7.getByRole("button", { name: "Open department 21 Отдел владельца" })).toBeVisible();
  await expect(page.getByTestId("org-expert-strip")).toBeVisible();

  const from = await departmentOf(page, "Testing");
  const to = from === 4 ? 6 : 4;
  const toLabel = to === 4 ? "4 Маркетинг" : "6 Приём заказов и сервис";

  await page.getByRole("button", { name: "Edit mode" }).click();
  const menu = page.getByRole("button", { name: "Actions for function Testing" });
  await menu.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("combobox", { name: "Move to department" }).selectOption({ label: toLabel });
  await expect.poll(() => functionsOf(page, to)).toContain("Testing");

  await page.reload();
  await expect.poll(() => functionsOf(page, to)).toContain("Testing");
  expect(await functionsOf(page, from)).not.toContain("Testing");

  await page.getByRole("button", { name: /^Undo/ }).click();
  await expect.poll(() => functionsOf(page, from)).toContain("Testing");
  await page.reload();
  expect(await functionsOf(page, from)).toContain("Testing");
  expect(await functionsOf(page, to)).not.toContain("Testing");
});

test("org board on a phone: one division at a time, no sideways page scroll", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await login(page, "nuraaly");
  await page.goto("/org?company=kiwi-go");
  await expect(page.locator('[data-testid=org-division][data-number="7"]')).toBeVisible();
  await expect(page.locator('[data-testid=org-division][data-number="1"]')).toBeHidden();
  await page.getByRole("button", { name: /^1 Персонал/ }).click();
  await expect(page.locator('[data-testid=org-division][data-number="1"]')).toBeVisible();
  const [scroll, width] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(scroll).toBeLessThanOrEqual(width);
  await context.close();
});
