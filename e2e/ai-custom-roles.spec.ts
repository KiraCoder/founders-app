import { expect, test } from "@playwright/test";
import { login } from "./helpers";

/** Today in Asia/Bishkek (the app's business day). */
function bishkekToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bishkek", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
const SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function addMonths(ym: string, n: number): string {
  let y = Number(ym.slice(0, 4));
  let m = Number(ym.slice(5, 7)) + n;
  while (m < 1) {
    m += 12;
    y -= 1;
  }
  while (m > 12) {
    m -= 12;
    y += 1;
  }
  return `${y}-${String(m).padStart(2, "0")}`;
}
const short = (ym: string) => `${SHORT[Number(ym.slice(5, 7)) - 1]} ${ym.slice(2, 4)}`;

test("create a custom role for Kiwi Go watching revenue with a 10% threshold → hire → run → the report shows the finding", async ({ page }) => {
  test.setTimeout(120_000);
  const lastMonth = addMonths(bishkekToday().slice(0, 7), -1);
  const prevMonth = addMonths(lastMonth, -1);
  const name = `Revenue watcher ${Date.now().toString(36)}`;
  await login(page, "nuraaly");

  // Revenue fell 12.5% (1 200 000 → 1 050 000): under the default 20%, over this role's 10%.
  await page.goto("/companies/kiwi-go?tab=numbers&g=month");
  await page.getByLabel(`Revenue, ${short(prevMonth)}`).fill("1200000");
  await page.getByLabel(`Revenue, ${short(lastMonth)}`).fill("1050000");
  const save = page.getByRole("button", { name: /^Save/ });
  if (await save.isEnabled()) {
    await save.click();
    await expect(page.getByText("Saved:")).toBeVisible();
  }

  // Create the role.
  await page.goto("/ai-roles");
  await page.getByRole("button", { name: "Create your own role" }).click();
  const dialog = page.getByRole("dialog", { name: "Create your own role" });
  await dialog.getByLabel("Company").selectOption({ label: "Kiwi Go" });
  await dialog.getByLabel("Role name").fill(name);
  await dialog.getByLabel("Job description").fill("Watches Kiwi Go revenue every month.");
  await dialog.getByLabel("Responsibilities").fill("Flag revenue moves of 10% or more");
  await expect(dialog.getByTestId("instructions-note")).toContainText("used after the AI provider is chosen");
  await dialog.getByLabel("Watch Revenue").check();
  await dialog.getByLabel("Change vs the month before: Warn at (%)").fill("10");
  await dialog.getByRole("button", { name: "Create role" }).click();
  await expect(dialog).toBeHidden();

  // Hire it.
  const roleCard = page.locator('[data-testid="custom-role"]', { hasText: name });
  await expect(roleCard).toContainText("Kiwi Go");
  await expect(roleCard).toContainText("Watches 1 number");
  await roleCard.getByRole("button", { name: "Hire for Kiwi Go" }).click();
  await expect(roleCard).toContainText("Hired");
  const hireCard = page.locator('[data-testid="hire-card"]', { hasText: name });
  await expect(hireCard).toContainText("Your role");
  await expect(hireCard).toContainText("waits for Revenue");

  // Its settings (per hire) open with the 10% threshold and the history.
  await hireCard.getByRole("button", { name: "Edit settings" }).click();
  const edit = page.getByRole("dialog", { name: `Edit ${name} · Kiwi Go` });
  await expect(edit.getByLabel("Change vs the month before: Warn at (%)")).toHaveValue("10");
  await expect(edit.getByTestId("editor-history")).toContainText("created");
  await edit.getByRole("button", { name: "Cancel" }).click();

  // Run → the report.
  await hireCard.getByRole("button", { name: "Run now (last month)" }).click();
  await page.waitForURL(/\/ai-roles\/runs\//);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(`${name} · Kiwi Go`);
  await expect(page.getByText("Reported", { exact: true })).toBeVisible();
  await expect(page.getByText(/Revenue fell 12\.5% vs/)).toBeVisible();
  await expect(page.getByRole("table")).toContainText("Revenue");
  await expect(page.getByRole("table")).not.toContainText("COD collected");
});
