import { expect, type Page } from "@playwright/test";

/** Must match the webServer env in playwright.config.ts (test-only values, not real secrets). */
export const E2E_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET ?? "e2e-telegram-webhook-secret";
export const E2E_CRON_SECRET = process.env.CRON_SECRET ?? "e2e-cron-secret";

export const PASSWORD = process.env.DEV_FOUNDER_PASSWORD ?? "founders-dev-2026";

export async function login(page: Page, who: "nuraaly" | "talant") {
  await page.goto("/login");
  await page.getByLabel("Email").fill(`${who}@founders.local`);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: /Good day/ })).toBeVisible();
}

export async function logout(page: Page) {
  await page.getByRole("button", { name: "User menu" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);
}
