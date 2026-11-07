import { expect, test } from "@playwright/test";
import { login } from "./helpers";

/** Generates docs/screenshots/*.png. Run with: SCREENSHOTS=1 npx playwright test screenshots */
test.skip(!process.env.SCREENSHOTS, "Set SCREENSHOTS=1 to regenerate screenshots");

test("desktop screenshots", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, "nuraaly");
  await page.screenshot({ path: "docs/screenshots/today-desktop.png" });
  await page.goto("/tasks?view=company");
  await page.screenshot({ path: "docs/screenshots/tasks-desktop.png" });
});

test("mobile screenshot", async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  await login(page, "nuraaly");
  await page.screenshot({ path: "docs/screenshots/today-mobile.png" });
  await context.close();
});

test("notification screenshots", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await login(page, "talant");
  await page.goto("/settings");
  const unlink = page.getByRole("button", { name: "Unlink" });
  if (await unlink.isVisible()) await unlink.click();
  await page.getByRole("button", { name: "Generate link code" }).click();
  await page.getByTestId("link-command").waitFor();
  await page.screenshot({ path: "docs/screenshots/settings-desktop.png", fullPage: true });
  await page.goto("/dev/notifications");
  await page.getByRole("button", { name: "Simulate morning" }).click();
  await page.getByText("Good morning, Talant").first().waitFor();
  await page.screenshot({ path: "docs/screenshots/dev-notifications-desktop.png", fullPage: true });
});

test("people screenshots", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await login(page, "nuraaly");
  await page.goto("/people/import");
  await page.getByLabel("Spreadsheet file").setInputFiles("docs/samples/people-sample.csv");
  await page.getByRole("button", { name: "Read file" }).click();
  await page.getByRole("button", { name: "Preview" }).click();
  await page.getByTestId("import-preview").waitFor();
  await page.screenshot({ path: "docs/screenshots/people-import-preview.png", fullPage: true });
  // Import the clearly fake sample people (idempotent) so the list shows salaries.
  const confirm = page.getByRole("button", { name: /^Import \d+ rows$/ });
  if (await confirm.isEnabled()) {
    await confirm.click();
    await page.getByRole("status").waitFor();
  }
  await page.goto("/people");
  await page.getByTestId("salary-header").waitFor();
  await page.screenshot({ path: "docs/screenshots/people-list-salaries.png", fullPage: true });
});

test("numbers screenshots", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await login(page, "nuraaly");
  // Load the clearly fake sample numbers (idempotent). "Active couriers" stops two days
  // early in the sample, so its card shows as stale.
  await page.goto("/companies/kiwi-go/numbers/import");
  await page.getByLabel("Spreadsheet file").setInputFiles("docs/samples/kiwi-go-numbers-sample.csv");
  await page.getByRole("button", { name: "Preview" }).click();
  await page.getByTestId("numbers-import-preview").waitFor();
  await page.screenshot({ path: "docs/screenshots/numbers-import-preview.png", fullPage: true });
  const confirm = page.getByRole("button", { name: /^Import \d+ numbers$/ });
  if (await confirm.isEnabled()) {
    await confirm.click();
    await page.getByRole("status").waitFor();
  }
  await page.goto("/companies/kiwi-go");
  await page.getByTestId("kpi-card").first().waitFor();
  await page.screenshot({ path: "docs/screenshots/company-overview-kpis.png", fullPage: true });
  await page.goto("/companies/kiwi-go?tab=numbers&g=day");
  await page.getByTestId("numbers-grid").waitFor();
  await page.screenshot({ path: "docs/screenshots/numbers-grid.png", fullPage: true });
  await page.goto("/companies");
  await page.screenshot({ path: "docs/screenshots/companies-freshness.png", fullPage: true });
});

test("holding screenshots", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await login(page, "nuraaly");
  await page.goto("/holding");
  await page.getByTestId("acts-grid").waitFor();
  await page.screenshot({ path: "docs/screenshots/holding-desktop.png", fullPage: true });
  // The "Ask for акты" card: one block per person, the Russian message, "Who to ask this month".
  const who = page.getByTestId("who-to-ask");
  if (await who.count()) await who.locator("summary").click();
  await page.getByTestId("ask-card").screenshot({ path: "docs/screenshots/holding-ask-card.png" });
  const cell = page.locator('[data-testid="act-cell"][data-cell-state="missing"]').first();
  await cell.click();
  await page.getByTestId("act-panel").waitFor();
  await page.screenshot({ path: "docs/screenshots/holding-act-panel.png" });
});

test("AI roles screenshots", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await login(page, "nuraaly");
  // The hire wizard on its "Data it needs" step (Alura Style: factory numbers per ХБК / Ош Район).
  await page.goto("/ai-roles");
  const styleCard = page.locator('[data-testid="hire-card"][data-company="alura-style"][data-role="financial-analyst"]');
  if (await styleCard.count()) await styleCard.getByRole("button", { name: "Tune" }).click();
  else {
    await page.getByRole("button", { name: "Hire Financial Analyst" }).click();
    await page.getByRole("dialog").getByRole("radio", { name: /Alura Style/ }).check();
    await page.getByRole("dialog").getByRole("button", { name: "Next" }).click();
  }
  await page.getByRole("dialog").waitFor();
  await page.screenshot({ path: "docs/screenshots/ai-roles-hire-wizard.png" });
  await page.keyboard.press("Escape");
  // The Kiwi Go report (made by e2e/ai-roles.spec.ts).
  const kiwi = page.locator('[data-testid="hire-card"][data-company="kiwi-go"][data-role="financial-analyst"]');
  await kiwi.getByRole("link", { name: /Latest/ }).click();
  await page.waitForURL(/\/ai-roles\/runs\//);
  await page.screenshot({ path: "docs/screenshots/ai-report.png", fullPage: true });
  await page.goto("/ai-roles");
  await page.screenshot({ path: "docs/screenshots/ai-roles-desktop.png", fullPage: true });
});

test("org structure screenshots", async ({ page, browser }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await login(page, "nuraaly");
  await page.goto("/org?company=kiwi-go");
  await page.getByTestId("org-board").waitFor();
  await page.screenshot({ path: "docs/screenshots/org-desktop.png" });
  await page.getByRole("button", { name: "Edit mode" }).click();
  await page.screenshot({ path: "docs/screenshots/org-edit-mode.png" });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const phone = await context.newPage();
  await login(phone, "nuraaly");
  await phone.goto("/org?company=kiwi-go");
  await phone.getByTestId("org-board").waitFor();
  await phone.screenshot({ path: "docs/screenshots/org-phone.png" });
  await context.close();
});

test("AI role editor and browser extension screenshots", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await login(page, "nuraaly");
  // The role editor (template level) of the Financial Analyst.
  await page.goto("/ai-roles");
  await page.locator('[data-testid="role-template"][data-role="financial-analyst"]').getByRole("button", { name: "Edit role" }).click();
  await page.getByRole("dialog").waitFor();
  await page.getByRole("dialog").getByTestId("editor-checks").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "docs/screenshots/ai-role-editor.png" });
  await page.keyboard.press("Escape");
  // A custom role's report (made by e2e/ai-custom-roles.spec.ts).
  const custom = page.locator('[data-testid="hire-card"]', { hasText: "Revenue watcher" }).first();
  await custom.getByRole("link", { name: /Latest/ }).click();
  await page.waitForURL(/\/ai-roles\/runs\//);
  // Numbers may have been corrected by later e2e runs: check them again first.
  const again = page.getByRole("button", { name: "Run again" });
  if (await page.getByText("Numbers changed").count()) {
    await again.click();
    await expect(page.getByText("Numbers changed")).toHaveCount(0);
  }
  await page.screenshot({ path: "docs/screenshots/ai-custom-role-report.png", fullPage: true });
  // Settings → Browser extension (a key just created; the key itself hidden again with Done).
  await page.goto("/settings");
  const card = page.getByTestId("extension-card");
  await card.getByLabel("Key name").fill("Laptop Chrome");
  await card.getByRole("button", { name: "Create key" }).click();
  await card.getByTestId("new-extension-key").waitFor();
  await card.getByRole("button", { name: "Done" }).click();
  await card.scrollIntoViewIfNeeded();
  await page.locator("section", { has: card }).screenshot({ path: "docs/screenshots/extension-keys.png" });
});

/**
 * The Linear-style Tasks pass (0034): /tasks, a task page, /routines and the profile / theme menu,
 * at 1400 px and 390 px, light and dark (deviceScaleFactor 1). docs/screenshots/linear/*.png.
 */
test("linear tasks screenshots", async ({ browser }) => {
  test.setTimeout(240_000);
  for (const scheme of ["light", "dark"] as const) {
    for (const [name, width, height] of [["desktop", 1400, 900], ["phone", 390, 844]] as const) {
      const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, colorScheme: scheme, isMobile: name === "phone", hasTouch: name === "phone" });
      const page = await context.newPage();
      await login(page, "nuraaly");
      const shot = (what: string) => page.screenshot({ path: `docs/screenshots/linear/${what}-${name}-${scheme}.png` });
      await page.goto("/tasks?view=all");
      await page.getByTestId("task-board").waitFor();
      await shot("tasks");
      await page.locator("li[data-task-id]").first().getByTestId("task-title").click();
      await page.getByTestId("task-properties").waitFor();
      await shot("task");
      await page.goto("/routines");
      await page.getByRole("search", { name: "Filter routines" }).waitFor();
      await shot("routines");
      await page.getByRole("button", { name: "User menu" }).click();
      await page.getByRole("group", { name: "Theme" }).waitFor();
      await shot("menu");
      await context.close();
    }
  }
});
