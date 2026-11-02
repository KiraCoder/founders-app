import { expect, test } from "@playwright/test";
import { login } from "./helpers";

/** Today in Asia/Bishkek as YYYY-MM-DD (the app's business day). */
function bishkekToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bishkek", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

test("enter a value on Kiwi Go → the KPI card shows it as fresh", async ({ page }) => {
  const value = 700 + Math.floor(Math.random() * 200);
  await login(page, "nuraaly");
  await page.goto("/companies/kiwi-go");
  const card = page.locator('[data-testid="kpi-card"][data-metric="orders_day"]');
  await expect(card).toBeVisible();

  await card.getByRole("button", { name: "Enter value for Orders per day" }).click();
  const form = card.getByRole("form", { name: "Enter value for Orders per day" });
  await form.getByLabel("Day").fill(bishkekToday());
  await form.getByLabel("Value (orders)").fill(String(value));
  await form.getByRole("button", { name: "Save" }).click();

  await expect(card.getByTestId("kpi-value")).toHaveText(`${value} orders`);
  await expect(card).toHaveAttribute("data-freshness", "fresh");
  await expect(card.getByText("Fresh", { exact: true })).toBeVisible();
  await expect(card.getByTestId("kpi-freshness")).toContainText("Updated today by Nuraaly");

  // The same number through the REST API (what the iOS app will use).
  const api = await page.request.get("/api/v1/companies/kiwi-go/metrics");
  const metrics = ((await api.json()) as { data: { key: string; latest: { value: number } | null; freshness: { status: string } }[] }).data;
  expect(metrics.find((m) => m.key === "orders_day")).toMatchObject({ latest: { value }, freshness: { status: "fresh" } });
});
