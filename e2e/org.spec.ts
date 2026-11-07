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

test("org board: real mouse drag-and-drop of a function, then undo", async ({ page }) => {
  // Tall window: both the handle and the drop place are on screen (mouse events need that).
  await page.setViewportSize({ width: 1440, height: 1800 });
  await login(page, "nuraaly");
  await page.goto("/org?company=kiwi-go");
  const from = await departmentOf(page, "Testing");
  const to = from === 4 ? 6 : 4;
  await page.getByRole("button", { name: "Edit mode" }).click();
  const handle = page.getByRole("button", { name: "Drag function Testing" });
  const target = page.locator(`[data-testid=org-department][data-number="${to}"] [data-testid=org-function]`).first();
  await target.scrollIntoViewIfNeeded();
  await handle.scrollIntoViewIfNeeded();
  const a = (await handle.boundingBox())!;
  const b = (await target.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + 20, a.y + 20, { steps: 5 });
  await page.mouse.move(b.x + b.width / 2, b.y + 4, { steps: 20 });
  await page.mouse.up();
  await expect.poll(() => functionsOf(page, to)).toContain("Testing");
  await page.reload();
  expect(await functionsOf(page, to)).toContain("Testing");
  await page.getByRole("button", { name: /^Undo/ }).click();
  await expect.poll(() => functionsOf(page, from)).toContain("Testing");
});

test("a task keeps its archived department when edited; the task row shows the department", async ({ page }) => {
  await login(page, "nuraaly");
  await page.goto("/org?company=kiwi-go");
  const name = `E2E Архив ${Date.now()}`;
  const d7 = page.locator('[data-testid=org-division][data-number="7"]');
  await d7.getByRole("button", { name: "+ Отдел" }).click();
  await page.getByLabel("Name of a new department in division 7").fill(name);
  await page.keyboard.press("Enter");
  const card = page.locator("[data-testid=org-department]", { hasText: name });
  await expect(card).toBeVisible();
  const deptId = (await card.getAttribute("data-id"))!;
  const number = await card.getAttribute("data-number");
  const companies = (await (await page.request.get("/api/v1/companies")).json()) as { data: { id: string; slug: string }[] };
  const kiwi = companies.data.find((c) => c.slug === "kiwi-go")!;
  const title = `[e2e] archived dept task ${Date.now()}`;
  const created = await page.request.post("/api/v1/tasks", { data: { title, companyId: kiwi.id, orgDepartmentId: deptId } });
  expect(created.status()).toBe(201);

  await card.getByRole("button", { name: /^Actions for department/ }).click();
  await page.getByRole("menuitem", { name: "Archive department" }).click();
  await expect(card).toHaveCount(0);

  await page.goto("/tasks?view=company");
  const row = page.locator("li[data-task-id]", { hasText: title });
  await expect(row.getByTestId("task-department")).toHaveText(`${number} ${name}`);
  await row.getByRole("button", { name: `More actions for ${title}` }).click();
  await page.getByRole("listbox", { name: `More actions for ${title}` }).getByRole("option", { name: "Edit…" }).click();
  const select = row.getByLabel("Department (org chart)");
  await expect(select.locator("option:checked")).toHaveText(`${number} ${name} (archived)`);
  await row.getByLabel("Title").fill(`${title} (edited)`);
  await row.getByRole("button", { name: "Save changes" }).click();
  await page.reload();
  const edited = page.locator("li[data-task-id]", { hasText: `${title} (edited)` });
  await expect(edited.getByTestId("task-department")).toHaveText(`${number} ${name}`);
});

test("people on the board: add Тест Курьеров from department 1's panel, initials after reload, positions on People", async ({ page }) => {
  await login(page, "nuraaly");
  await page.goto("/org?company=kiwi-go");
  await page.getByRole("button", { name: "Open department 1 Найм и ввод в должность" }).click();
  const panel = page.getByTestId("org-department-panel");
  const fnText = (await panel.locator("li p").first().textContent())!.trim();
  await panel.getByRole("button", { name: `New person for: Responsible for ${fnText}` }).click();
  const form = panel.getByTestId("org-new-person");
  await form.getByLabel("Full name").fill("Тест Курьеров");
  await form.getByLabel("Short name").fill("Тест");
  await form.getByLabel("Phone").fill("+996 555 000 111");
  await form.getByLabel("Telegram").fill("@test_kurierov");
  await expect(form.getByLabel("Role / title")).toHaveValue(fnText.slice(0, 120));
  await form.getByRole("button", { name: "Create and assign" }).click();
  await expect(page.getByText("Тест Курьеров added to People and assigned.")).toBeVisible();

  await page.reload();
  const row = page.locator(`[data-testid=org-department][data-number="1"] [data-testid=org-function]`).filter({ hasText: fnText }).first();
  const initials = row.getByTestId("org-initials");
  await expect(initials).toHaveText("ТК");
  await expect(initials).toHaveAttribute("title", "Тест Курьеров");
  // Empty slots offer "+ назначить" to founders.
  await expect(page.getByRole("button", { name: /^Assign / }).first()).toBeVisible();

  await page.goto(`/people?q=${encodeURIComponent("Тест Курьеров")}`);
  const listed = page.locator("tr", { hasText: "Тест Курьеров" }).filter({ hasText: "1 Найм и ввод в должность" }).first();
  await expect(listed).toBeVisible();
  await listed.getByRole("link", { name: "Тест Курьеров" }).click();
  await expect(page.getByTestId("person-org-positions")).toContainText("1 Найм и ввод в должность");
  await expect(page.getByTestId("person-org-positions")).toContainText("Kiwi Go");
});
