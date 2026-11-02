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
