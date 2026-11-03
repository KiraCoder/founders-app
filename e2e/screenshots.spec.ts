import { test } from "@playwright/test";
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
  const styleCard = page.locator('[data-testid="hire-card"][data-company="alura-style"]');
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
  const kiwi = page.locator('[data-testid="hire-card"][data-company="kiwi-go"]');
  await kiwi.getByRole("link", { name: /Latest/ }).click();
  await page.waitForURL(/\/ai-roles\/runs\//);
  await page.screenshot({ path: "docs/screenshots/ai-report.png", fullPage: true });
  await page.goto("/ai-roles");
  await page.screenshot({ path: "docs/screenshots/ai-roles-desktop.png", fullPage: true });
});
