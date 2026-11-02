import { expect, type Page } from "@playwright/test";

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
