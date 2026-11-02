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
